import { db } from "./db"
import { botConfig, gridConfigs, gridOrders, trades, botLogs, type BotConfig, type GridOrder } from "./db/schema"
import { eq, sql, and, inArray, desc } from 'drizzle-orm'
import type { FeatureVector, IndicatorSnapshot } from "./indicators"
import { detectVolatilitySurge, adaptiveSpacing, type VolatilityState } from "./volatility-guard"
import type { Regime } from "./strategy"
import { loadModel, trainOnTrade } from "./ml"
import { getExchangeClient, type ExchangeClient } from "./exchange"
import { placePostOnlyOrder, placeMarketOrder as makerMarketOrder, fetchOrderStatus, cancelOrders } from "./mexc/private"
import { fetchTicker } from "./mexc/public"

// Grid trading engine: a ladder of buy levels below price with paired sell
// targets one spacing above. Profits from oscillation inside a range.
// Complements the signal strategies — regime detection auto-pauses the grid
// when the market starts trending (a breakout is the grid's worst enemy).


const TAKER_FEE = 0.0002
// Maker mode risk controls: protect held inventory regardless of pause state.
const MAKER_STOP_LOSS_PCT = 0.04   // close at market if price moves 4% against entry
const MAKER_MAX_HOLD_MINUTES = 240 // force-close after 4 hours regardless of price
const MAKER_RECENTER_DRIFT_PCT = 0.15 // rebuild buy ladder if price drifts 15% from all resting buys

// MEXC's order/create returns the id nested (e.g. { data: { orderId } }) or as a
// bare value depending on endpoint. Extract a clean string id, never "[object Object]".
function extractOrderId(res: any): string | null {
  const d = res?.data ?? res
  if (d == null) return null
  if (typeof d === "object") {
    const id = d.orderId ?? d.order_id ?? d.id
    return id != null ? String(id) : null
  }
  return String(d)
}

// Drizzle wraps the real DB reason in err.cause; surface it so failures are legible.
function dbErr(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause
    const detail = cause?.detail ?? cause?.message ?? cause?.code
    return detail ? `${err.message} | cause: ${detail}` : err.message
  }
  return String(err)
}

// --- Maker mode (post-only resting orders) ---
// OFF by default. Enable with GRID_MAKER=1. Scope to specific symbols with
// GRID_MAKER_SYMBOLS="BANK_USDT,ADA_USDT" (empty list = all symbols when on).
// Only affects LIVE mode; paper mode always uses the virtual-fill path.
const MAKER_ENABLED = process.env.GRID_MAKER === "1"
// Scope which symbols use maker mode. We intentionally do NOT read a symbols
// env var here (the deploy pipeline mangles that name). Default scope is the
// single test symbol below; edit this array to add more once proven.
const MAKER_SYMBOLS: string[] = ["BANK_USDT", "RIVER_USDT"]
function isMakerSymbol(symbol: string): boolean {
  return MAKER_ENABLED && (MAKER_SYMBOLS.length === 0 || MAKER_SYMBOLS.includes(symbol))
}

function roundForMexc(symbol: string, price: number, quantity: number): { price: number, quantity: number } {
  const specs: Record<string, {ps: number, qs: number}> = {
    "BTC_USDT": {ps: 1, qs: 0},
    "ETH_USDT": {ps: 2, qs: 0},
    "BANK_USDT": {ps: 5, qs: 4},
    "ADA_USDT": {ps: 5, qs: 4},
    "RIVER_USDT": {ps: 4, qs: 2},
  }
  const s = specs[symbol] || {ps: price < 1 ? 5 : 2, qs: 0}
  let qty = Math.floor(quantity * Math.pow(10, s.qs)) / Math.pow(10, s.qs)
  if (qty < Math.pow(10, -s.qs)) qty = Math.pow(10, -s.qs)
  // Quantity rounding now handled by lib/mexc/precision.ts in placeMarketOrder
  return {
    price: Math.round(price * Math.pow(10, s.ps)) / Math.pow(10, s.ps),
    quantity: qty
  }
}

export interface GridConfig {
  id: number
  symbol: string
  timeframe: string
  enabled: boolean
  levels: number
  rangeAtrMult: number
  budgetPct: number
  leverage: number
  feeMarginMult: number
  autoPause: boolean
}
export async function getGridConfigs(): Promise<GridConfig[]> {
  const rows = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    enabled: r.enabled,
    levels: r.levels,
    rangeAtrMult: r.rangeAtrMult,
    budgetPct: r.budgetPct,
    leverage: r.leverage,
    feeMarginMult: r.feeMarginMult,
    autoPause: r.autoPause,
  }))
}

async function log(level: "info" | "trade" | "error", message: string, details?: unknown) {
  await db.insert(botLogs).values({
    level,
    message,
    details: details || null,
  })
}

export async function getActiveOrders(symbol?: string, timeframe?: string): Promise<GridOrder[]> {
  const conditions = [eq(gridOrders.status, "pending")]
  if (symbol) conditions.push(eq(gridOrders.symbol, symbol))
  if (timeframe) conditions.push(eq(gridOrders.timeframe, timeframe))
  return db.select().from(gridOrders).where(and(...conditions))
}

// Build the ladder: buy levels below current price across the lower half of
// the range. Sells are placed dynamically one spacing above each filled buy.
export async function setupGrid(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, volatility?: VolatilityState, exchange?: ExchangeClient, startAtPrice = false): Promise<void> {
  const center = snap.price
  const configuredHalf = snap.atr * gc.rangeAtrMult

  // Fee-aware spacing floor. A completed cycle earns one spacing and pays a
  // buy+sell round trip. The configured level count is a ceiling: thin the
  // ladder when volatility is too low for every rung to clear the fee floor.
  const breakeven = center * 2 * TAKER_FEE
  const feeBasedMin = breakeven * gc.feeMarginMult
  // Minimum 0.3% spacing for low-price coins where fee calculation rounds to 0
  const pctBasedMin = center * 0.003
  const minSpacing = Math.max(feeBasedMin, pctBasedMin)
  const configuredWidth = configuredHalf * 2
  const atrSpacing = configuredWidth / gc.levels
  const maxLevelsForRange = Math.floor(configuredWidth / minSpacing)
  const effectiveLevels = Math.min(gc.levels, Math.max(1, maxLevelsForRange))
  // Adapt spacing to volatility — wider during surges to capture extremes
  const baseSpacing = Math.max(atrSpacing, minSpacing)
  const spacing = volatility 
    ? adaptiveSpacing(baseSpacing, volatility, minSpacing)
    : baseSpacing

  // Ensure the persisted/displayed range contains every generated rung. This
  // matters when even two fee-safe rungs do not fit inside the ATR range.
  const buyLevels = Math.max(1, Math.floor(effectiveLevels / 2))
  const effectiveHalf = Math.max(configuredHalf, spacing * buyLevels)
  const lower = center - effectiveHalf
  const upper = center + effectiveHalf
  // Use live balance for sizing in live mode, paper balance for paper mode
  let effectiveBalance = cfg.paperBalance
  if (cfg.mode === "live") {
    try {
      const { getAccountAssets } = await import("./mexc/private")
      const assets = await getAccountAssets() as any[]
      const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
      if (usdt) effectiveBalance = usdt.availableBalance
    } catch (err) {}
  }
  const budget = (effectiveBalance * gc.budgetPct) / 100
  const notionalPerLevel = (budget / buyLevels) * gc.leverage

  const orders = []
  // After a big drop, place buys at current price with stairs going UP
    // This catches the recovery instead of waiting for more downside.
    // Maker mode forces the normal downward ladder: post-only buys must rest
    // BELOW market or MEXC rejects them, so never stair up for maker symbols.
    const recentDrop = !isMakerSymbol(gc.symbol) && (startAtPrice || (volatility && volatility.atrPercentile > 50))
    const startPrice = recentDrop ? center : center - spacing
    const direction = recentDrop ? 1 : -1  // Up if recovering, down if normal
    
    for (let i = 1; i <= buyLevels; i++) {
      const price = startPrice + direction * spacing * (i - 1)
      if (price <= 0) continue
    orders.push({
      symbol: gc.symbol,
      timeframe: gc.timeframe,
      leverage: gc.leverage,
      spacing,
      levelIndex: i,
      side: "buy" as const,
      price,
      quantity: notionalPerLevel / price,
      status: "pending" as const,
    })
  }
  if (volatility && volatility.surge) {
    await log("info", `Grid ${gc.symbol}: ${volatility.reason}`)
  }

  // Maker (live): place each buy as a real resting post-only order and store
  // its MEXC order id. Market/paper path inserts virtual rows as before.
  if (cfg.mode === "live" && isMakerSymbol(gc.symbol)) {
    for (const ord of orders) {
      try {
        const res: any = await placePostOnlyOrder({
          symbol: ord.symbol,
          side: 1,
          price: ord.price,
          volume: ord.quantity,
          leverage: ord.leverage,
        })
              const oid = extractOrderId(res)
              await db.insert(gridOrders).values({ ...ord, mexcOrderId: oid, exchangeStatus: "new" })
              await log("info", `Grid ${gc.symbol} (maker): resting buy @ ${ord.price.toFixed(6)} id=${oid}`)
            } catch (err) {
              await log("error", `Grid ${gc.symbol} (maker): buy rejected @ ${ord.price.toFixed(6)}: ${dbErr(err)}`)
      }
    }
  } else if (orders.length > 0) {
    await db.insert(gridOrders).values(orders)
  }

  await db
    .update(botConfig)
    .set({
      gridCenter: center,
      gridLower: lower,
      gridUpper: upper,
      gridSpacing: spacing,
      gridEffectiveLevels: effectiveLevels,
      gridPaused: false,
    })
    .where(eq(botConfig.id, 1))

  await log(
    "info",
    `Grid set up: ${orders.length} buy levels between ${lower.toFixed(2)} and ${center.toFixed(2)} | spacing ${spacing.toFixed(6)} (breakeven ${breakeven.toFixed(6)}) | budget ${budget.toFixed(2)} USDT x${gc.leverage}`,
  )

  if (spacing > atrSpacing * 1.001) {
    await log(
      "info",
      `Grid spacing widened for fees: ATR spacing ${atrSpacing.toFixed(2)} was below the fee floor ${minSpacing.toFixed(4)}. Using ${effectiveLevels} of ${gc.levels} configured levels — raise "Range (ATR x)" to keep more levels.`,
    )
  }
}

export async function teardownGrid(cfg: BotConfig, currentPrice: number | null): Promise<void> {
  const active = await getActiveOrders(cfg.symbol, cfg.timeframe)

  // Maker: cancel real resting orders on the exchange first so we never leave
  // orphaned post-only orders behind after a manual stop.
  const makerIds = active.filter((o) => o.mexcOrderId && isMakerSymbol(o.symbol)).map((o) => o.mexcOrderId!) as string[]
  if (makerIds.length > 0) {
    try {
      await cancelOrders(makerIds)
      await log("info", `Grid teardown: cancelled ${makerIds.length} resting maker orders on exchange`)
    } catch (err) {
      await log("error", `Grid teardown: failed cancelling maker orders: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Liquidate held inventory (filled buys awaiting sells) at market
  const holding = active.filter((o) => o.side === "sell")
  for (const o of holding) {
    if (currentPrice != null && o.buyPrice != null) {
      await settleGridSell(o, currentPrice, cfg, "manual", exchange)
    }
  }

  const remaining = active.filter((o) => o.side === "buy").map((o) => o.id)
  if (remaining.length > 0) {
    await db.update(gridOrders).set({ status: "cancelled" }).where(inArray(gridOrders.id, remaining))
  }

  await db
    .update(botConfig)
    .set({
      gridCenter: null,
      gridLower: null,
      gridUpper: null,
      gridSpacing: null,
      gridEffectiveLevels: null,
      gridPaused: false,
    })
    .where(eq(botConfig.id, 1))

  await log("info", "Grid torn down — pending buys cancelled, held inventory liquidated")
}

async function settleGridSell(
  order: GridOrder,
  exitPrice: number,
  cfg: BotConfig,
  reason: "tp" | "manual",
  exchange?: ExchangeClient
): Promise<void> {
  if (cfg.mode === "live") {
    try {
      if (exchange) { const r = roundForMexc(order.symbol, order.price, order.quantity); await exchange.placeMarketOrder({ symbol: order.symbol, side: 4, volume: r.quantity, leverage: order.leverage }) }
    } catch (err) {
      await log("error", `LIVE grid sell failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }

  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = (buyPrice * order.quantity) / order.leverage
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  const buyFee = buyPrice * order.quantity * TAKER_FEE
  const sellFee = exitPrice * order.quantity * TAKER_FEE
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol,
      side: "long",
      entryPrice: buyPrice,
      exitPrice,
      sizeUsdt,
      leverage: order.leverage,
      pnl: netPnl,
      fees,
      exitReason: reason,
      strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  await db
    .update(gridOrders)
    .set({ status: "filled", filledAt: sql`NOW()` })
    .where(eq(gridOrders.id, order.id))

  // The buy fee was deducted when the rung filled. Add only gross PnL minus
  // the sell fee here, otherwise the buy fee is charged twice.
  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` })
    .where(eq(botConfig.id, 1))

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModel()
      await trainOnTrade(
        model,
        order.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
        cfg.mlLearningRate,
        trade.id,
        null,
      )
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log(
    "trade",
    `Grid sell filled @ ${exitPrice.toFixed(2)} (bought ${buyPrice.toFixed(2)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`,
  )
}

// Maker settle: the resting post-only sell already executed on the exchange,
// so we do NOT place any order here — we only record the trade and books.
async function settleMakerSell(order: GridOrder, exitPrice: number, cfg: BotConfig): Promise<void> {
  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = (buyPrice * order.quantity) / order.leverage
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  const buyFee = buyPrice * order.quantity * TAKER_FEE
  const sellFee = exitPrice * order.quantity * TAKER_FEE
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol,
      side: "long",
      entryPrice: buyPrice,
      exitPrice,
      sizeUsdt,
      leverage: order.leverage,
      pnl: netPnl,
      fees,
      exitReason: "tp",
      strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  await db
    .update(gridOrders)
    .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
    .where(eq(gridOrders.id, order.id))

  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` })
    .where(eq(botConfig.id, 1))

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModel()
      await trainOnTrade(
        model,
        order.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
        cfg.mlLearningRate,
        trade.id,
        null,
      )
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log(
    "trade",
    `Grid ${order.symbol} (maker) sell filled @ ${exitPrice.toFixed(6)} (bought ${buyPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`,
  )
}

// Maker tick: fills are detected from REAL MEXC order status, not price
// crossing. v1 intentionally omits auto-pause and auto-recenter — watch it.
async function settleMakerStopLoss(order: GridOrder, exitPrice: number, cfg: BotConfig, reason: "stop-loss" | "max-hold"): Promise<void> {
  if (order.mexcOrderId) {
    try {
      await cancelOrders([order.mexcOrderId])
    } catch (err) {
      await log("error", `Grid ${order.symbol} (maker): failed cancelling resting sell before ${reason}: ${dbErr(err)}`)
    }
  }
  try {
    await makerMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage })
  } catch (err) {
    await log("error", `Grid ${order.symbol} (maker): ${reason} market close FAILED, will retry next tick: ${dbErr(err)}`)
    return
  }

  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = (buyPrice * order.quantity) / order.leverage
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  const buyFee = buyPrice * order.quantity * TAKER_FEE
  const sellFee = exitPrice * order.quantity * TAKER_FEE
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol, side: "long", entryPrice: buyPrice, exitPrice,
      sizeUsdt, leverage: order.leverage, pnl: netPnl, fees,
      exitReason: reason, strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  await db.update(gridOrders).set({ status: "filled", exchangeStatus: "cancelled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, order.id))
  await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` }).where(eq(botConfig.id, 1))

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModel()
      await trainOnTrade(model, order.entryFeatures as unknown as FeatureVector, netPnl > 0, sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0, cfg.mlLearningRate, trade.id, null)
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log("trade", `Grid ${order.symbol} (maker) ${reason.toUpperCase()} closed @ ${exitPrice.toFixed(6)} (bought ${buyPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
}

async function runGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  const volatility = detectVolatilitySurge(gc.symbol, snap)
  const paused = gc.autoPause && regime === "trend"

  const gridConfigRow = await db.select().from(gridConfigs).where(
    and(eq(gridConfigs.symbol, gc.symbol), eq(gridConfigs.timeframe, gc.timeframe))
  ).limit(1)

  if (gridConfigRow.length > 0 && gridConfigRow[0].paused !== paused) {
    await db.update(gridConfigs).set({ paused }).where(eq(gridConfigs.id, gridConfigRow[0].id))
    if (paused) {
      const restingBuys = active.filter((o) => o.side === "buy" && o.mexcOrderId)
      if (restingBuys.length > 0) {
        try {
          await cancelOrders(restingBuys.map((o) => o.mexcOrderId!) as string[])
          await db.update(gridOrders)
            .set({ status: "cancelled", exchangeStatus: "cancelled" })
            .where(inArray(gridOrders.id, restingBuys.map((o) => o.id)))
          await log("info", `Grid ${gc.symbol} (maker): trend detected — cancelled ${restingBuys.length} resting buy(s) on exchange`)
        } catch (err) {
          await log("error", `Grid ${gc.symbol} (maker): trend detected but failed cancelling resting buys: ${dbErr(err)}`)
        }
      } else {
        await log("info", `Grid ${gc.symbol} (maker): trend detected — auto-paused, no resting buys to cancel`)
      }
    } else {
      await log("info", `Grid ${gc.symbol} (maker): ranging conditions restored — resuming buy ladder`)
    }
    active = await getActiveOrders(gc.symbol, gc.timeframe)
  }

  if (active.length === 0) {
    if (!gc.enabled) return
    if (paused) return
    await log("info", `Grid ${gc.symbol} (maker): setting up fresh resting ladder`)
    await setupGrid(cfg, gc, snap, volatility, undefined, true)
    return
  }

  // Auto-recenter: cancel stale resting buys and rebuild near current price
  // if the market has moved too far away for them to realistically fill.
  if (!paused) {
    const restingBuys = active.filter((o) => o.side === "buy" && o.mexcOrderId)
    if (restingBuys.length > 0) {
      let livePrice: number | null = null
      try {
        livePrice = (await fetchTicker(gc.symbol)).lastPrice
      } catch {}
      if (livePrice != null) {
        const minDrift = Math.min(...restingBuys.map((o) => Math.abs(livePrice! - o.price) / livePrice!))
        if (minDrift > MAKER_RECENTER_DRIFT_PCT) {
          await log("info", `Grid ${gc.symbol} (maker): price drifted ${(minDrift * 100).toFixed(1)}% from resting buys. Recentering at ${livePrice.toFixed(6)}.`)
          try {
            await cancelOrders(restingBuys.map((o) => o.mexcOrderId!) as string[])
            await db.update(gridOrders)
              .set({ status: "cancelled", exchangeStatus: "cancelled" })
              .where(inArray(gridOrders.id, restingBuys.map((o) => o.id)))
            await setupGrid(cfg, gc, snap, volatility, undefined, true)
          } catch (err) {
            await log("error", `Grid ${gc.symbol} (maker): recenter failed: ${dbErr(err)}`)
          }
          return
        }
      }
    }
  }

  const spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult

  // Poll resting BUY orders for real fills
  const buys = active.filter((o) => o.side === "buy" && o.mexcOrderId)
  for (const o of buys) {
    const st: any = await fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    const state = Number(st.state)
    if (state === 3) {
      const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      await db
        .update(gridOrders)
        .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
        .where(eq(gridOrders.id, o.id))
      const buyFee = fillPrice * o.quantity * TAKER_FEE
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} - ${buyFee}` }).where(eq(botConfig.id, 1))

      const sellPrice = fillPrice + spacing
      try {
        const res: any = await placePostOnlyOrder({
          symbol: o.symbol,
          side: 4,
          price: sellPrice,
          volume: o.quantity,
          leverage: o.leverage,
        })
              const sid = extractOrderId(res)
        await db.insert(gridOrders).values({
          symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
          spacing, levelIndex: o.levelIndex, side: "sell",
          price: sellPrice, quantity: o.quantity, buyPrice: fillPrice,
          entryFeatures: { ...snap.features, sideLong: 1 },
          mexcOrderId: sid, exchangeStatus: "new", status: "pending",
        })
        await log("trade", `Grid ${o.symbol} (maker) buy filled @ ${fillPrice.toFixed(6)} | resting sell @ ${sellPrice.toFixed(6)}`)
      } catch (err) {
              await log("error", `Grid ${o.symbol} (maker): sell placement failed @ ${sellPrice.toFixed(6)}: ${dbErr(err)}`)
      }
    } else if (state === 4 || state === 5) {
      await db.update(gridOrders).set({ status: "cancelled", exchangeStatus: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }

  // Poll resting SELL orders for real fills
  const sells = active.filter((o) => o.side === "sell" && o.mexcOrderId)
  for (const o of sells) {
    const st: any = await fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    const state = Number(st.state)
    if (state === 3) {
      const exitPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      await settleMakerSell(o, exitPrice, cfg)
      // Re-arm a resting maker buy back at the original level
      if (o.buyPrice != null && !paused) {
        try {
          const res: any = await placePostOnlyOrder({
            symbol: o.symbol,
            side: 1,
            price: o.buyPrice,
            volume: o.quantity,
            leverage: o.leverage,
          })
              const bid = extractOrderId(res)
          await db.insert(gridOrders).values({
            symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
            spacing: o.spacing, levelIndex: o.levelIndex, side: "buy",
            price: o.buyPrice, quantity: o.quantity,
            mexcOrderId: bid, exchangeStatus: "new", status: "pending",
          })
        } catch (err) {
              await log("error", `Grid ${o.symbol} (maker): re-arm buy failed @ ${o.buyPrice.toFixed(6)}: ${dbErr(err)}`)
        }
      }
    } else if (state === 4 || state === 5) {
      await db.update(gridOrders).set({ status: "cancelled", exchangeStatus: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }

  // Risk control: protect held inventory regardless of pause/regime state.
  const heldSells = active.filter((o) => o.side === "sell" && o.buyPrice != null && o.status === "pending")
  if (heldSells.length > 0) {
    let currentPrice: number | null = null
    try {
      currentPrice = (await fetchTicker(gc.symbol)).lastPrice
    } catch {}
    if (currentPrice != null) {
      for (const o of heldSells) {
        const buyPrice = o.buyPrice as number
        const adverseMove = (currentPrice - buyPrice) / buyPrice
        const heldMinutes = o.createdAt ? (Date.now() - new Date(o.createdAt as any).getTime()) / 60000 : 0
        if (adverseMove <= -MAKER_STOP_LOSS_PCT) {
          await log("info", `Grid ${o.symbol} (maker): stop-loss triggered — price ${currentPrice.toFixed(6)} is ${(adverseMove * 100).toFixed(2)}% below entry ${buyPrice.toFixed(6)}`)
          await settleMakerStopLoss(o, currentPrice, cfg, "stop-loss")
        } else if (heldMinutes >= MAKER_MAX_HOLD_MINUTES) {
          await log("info", `Grid ${o.symbol} (maker): max-hold triggered — held ${heldMinutes.toFixed(0)}m, closing at market`)
          await settleMakerStopLoss(o, currentPrice, cfg, "max-hold")
        }
      }
    }
  }
}

export async function runGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange?: ExchangeClient): Promise<void> {
  // Maker mode (live + enabled symbol): use the real-order polling path and
  // skip the entire virtual-fill engine below.
  if (cfg.mode === "live" && isMakerSymbol(gc.symbol)) {
    return runGridTickMaker(cfg, gc, snap, regime)
  }

  const active = await getActiveOrders(gc.symbol, gc.timeframe)

  // Detect volatility surge for adaptive spacing
  const volatility = detectVolatilitySurge(gc.symbol, snap)

  // No active orders for this pair — set up a fresh ladder
  if (active.length === 0) {
    if (!gc.enabled) return
    // Track how many ticks the grid has been empty
    const emptyTicks = (gc as any)._emptyTicks || 0
    if (emptyTicks >= 2) {
      await log("info", `Grid ${gc.symbol}: force-rebuilding after ${emptyTicks} empty ticks`)
    }
    (gc as any)._emptyTicks = emptyTicks + 1
    await log("info", `Grid ${gc.symbol}: setting up fresh ladder`)
    await setupGrid(cfg, gc, snap, volatility, exchange, true)
    return
  }
  // Reset empty tick counter when orders exist
  ;(gc as any)._emptyTicks = 0

  // Use live ticker price for accurate fill detection
  let price = snap.price
  try {
    if (exchange) {
      const ticker = await exchange.fetchTicker(gc.symbol)
      if (ticker?.lastPrice) price = ticker.lastPrice
    }
  } catch (err) { /* use snap.price as fallback */ }
  if (!price || price <= 0) {
    const sellPrices = active.filter(o => o.side === "sell").map(o => o.price)
    if (sellPrices.length > 0) price = Math.max(...sellPrices) + 0.0001
  }
  let spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
  const paused = gc.autoPause && regime === "trend"
  
  // During trends, place one order in the direction of the move
  if (paused) {
    const hasTrendOrder = active.some(o => o.levelIndex === 99)
    if (!hasTrendOrder) {
      // Use per-level sizing, not full budget
      const perLevelBudget = (cfg.paperBalance * gc.budgetPct / 100) / gc.levels
      const trendPrice = price * 1.10  // 10% above current — catches the pump
      const trendQty = (perLevelBudget * gc.leverage) / trendPrice
      await db.insert(gridOrders).values({
        symbol: gc.symbol, timeframe: gc.timeframe, leverage: gc.leverage,
        spacing: spacing, levelIndex: 99, side: "sell",
        price: trendPrice, quantity: trendQty, buyPrice: price, status: "pending",
      })
      await log("info", `Grid ${gc.symbol}: trending up — placed sell @ ${trendPrice.toFixed(6)} (+10%)`)
    }
  }
  
  // Update paused state in grid_configs
  const gridConfigRow = await db.select().from(gridConfigs).where(
    and(eq(gridConfigs.symbol, gc.symbol), eq(gridConfigs.timeframe, gc.timeframe))
  ).limit(1)
  
  if (gridConfigRow.length > 0 && gridConfigRow[0].paused !== paused) {
    await db.update(gridConfigs)
      .set({ paused })
      .where(eq(gridConfigs.id, gridConfigRow[0].id))
    await log("info", paused
      ? `Grid ${gc.symbol} auto-paused: trending regime detected. Sells remain active.`
      : `Grid ${gc.symbol} resumed: ranging conditions restored`)
  }

  // Auto-recenter: if price has drifted far from all orders, rebuild ladder
  const allPrices = active.map(o => o.price)
  if (allPrices.length > 0) {
    const minOrderPrice = Math.min(...allPrices)
    const maxOrderPrice = Math.max(...allPrices)
    const priceDrift = Math.min(
      Math.abs(price - minOrderPrice) / price * 100,
      Math.abs(price - maxOrderPrice) / price * 100
    )
    // If price is >15% away from the nearest order, tear down and rebuild
    if (priceDrift > 15) {
      await log("info", `Grid ${gc.symbol}: price drifted ${priceDrift.toFixed(1)}% from orders. Recentering ladder at ${price.toFixed(4)}.`)
      // Cancel ALL pending orders — if price crashed >40%, sells are hopeless
      const cancelAll = priceDrift > 40
      for (const o of active) {
        if (o.side === "buy" || cancelAll) {
          await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
        }
      }
      // Rebuild buys at current price
      await setupGrid(cfg, gc, snap, volatility, exchange)
      return
    }
  }

  // 1) Sell fills: price rose to/above a pending sell level
  const sells = active.filter((o) => o.side === "sell" && price >= o.price)
  for (const o of sells) {
    await settleGridSell(o, o.price, cfg, "tp", exchange)
    // Re-arm the buy at its original level
    if (o.buyPrice != null) {
      await db.insert(gridOrders).values({
        symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
        spacing: o.spacing, levelIndex: o.levelIndex, side: "buy",
        price: o.buyPrice, quantity: o.quantity, status: "pending",
      })
    }
  }

  // 2) Buy fills: price dropped to/below a pending buy level (skip when paused)
  if (!paused && spacing != null) {
    const buys = active.filter((o) => o.side === "buy" && price <= o.price)
    for (const o of buys) {
      if (cfg.mode === "live") {
        try {
          if (exchange) { const r = roundForMexc(o.symbol, o.price, o.quantity); await log("info", `LIVE buy: ${o.symbol} price=${r.price} qty=${r.quantity} lev=${o.leverage}`); await exchange.placeMarketOrder({ symbol: o.symbol, side: 1 as any, volume: r.quantity, leverage: o.leverage }) }
        } catch (err) {
          await log("error", `LIVE grid buy failed: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
      }

      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const buyFee = o.price * o.quantity * TAKER_FEE
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} - ${buyFee}` }).where(eq(botConfig.id, 1))

      // Check the DATABASE for existing sells to prevent duplicates
      const existingSells = await db.select().from(gridOrders).where(
        and(
          eq(gridOrders.symbol, o.symbol),
          eq(gridOrders.side, "sell"),
          eq(gridOrders.buyPrice, o.price),
          eq(gridOrders.levelIndex, o.levelIndex),
          eq(gridOrders.status, "pending")
        )
      )
      if (existingSells.length > 0) continue
      
      await db.insert(gridOrders).values({
        symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
        spacing, levelIndex: o.levelIndex, side: "sell",
        price: o.price + spacing, quantity: o.quantity, buyPrice: o.price,
        // ON CONFLICT DO NOTHING handled by database unique index
        entryFeatures: { ...snap.features, sideLong: 1 },
        status: "pending",
      })

      await log("trade", `Grid ${o.symbol} buy @ ${o.price.toFixed(4)} | sell placed @ ${(o.price + spacing).toFixed(4)}`)
    }
  }
}


export async function gridUnrealizedPnl(currentPrice: number, symbol?: string, timeframe?: string): Promise<number> {
  const conditions = [eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell")]
  if (symbol) conditions.push(eq(gridOrders.symbol, symbol))
  if (timeframe) conditions.push(eq(gridOrders.timeframe, timeframe))
  const holding = await db.select().from(gridOrders).where(and(...conditions))
  return holding.reduce((acc, o) => acc + (currentPrice - (o.buyPrice ?? o.price)) * o.quantity, 0)
}

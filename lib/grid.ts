import { db } from "./db"
import { botConfig, gridConfigs, gridOrders, trades, botLogs, type BotConfig, type GridOrder } from "./db/schema"
import { eq, sql, and, inArray, desc } from 'drizzle-orm'
import type { FeatureVector, IndicatorSnapshot } from "./indicators"
import { detectVolatilitySurge, adaptiveSpacing, type VolatilityState } from "./volatility-guard"
import type { Regime } from "./strategy"
import { loadModel, trainOnTrade } from "./ml"
import { getExchangeClient, type ExchangeClient } from "./exchange"
import { placePostOnlyOrder, placeMarketOrder as makerMarketOrder, fetchOrderStatus, cancelOrders } from "./mexc/private"
import { marketScales } from "./mexc/public"
import type { Candle } from "./mexc/public"
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
// Global kill switch: OFF entirely unless GRID_MAKER=1. Per-symbol enablement
// is now DB-driven via gridConfigs.makerMode, settable from the dashboard —
// no more code edits/rebuilds needed to bring a new pair into maker mode.
// Only affects LIVE mode; paper mode always uses the virtual-fill path.
const MAKER_ENABLED = process.env.GRID_MAKER === "1"
function isMakerSymbol(gc: { makerMode?: boolean }): boolean {
  return MAKER_ENABLED && !!gc.makerMode
}

function roundForMexc(symbol: string, price: number, quantity: number): { price: number, quantity: number } {
  // Use live MEXC contract scales, fallback to safe defaults if not yet fetched
  const scale = marketScales[symbol] || { price: 2, amount: 0 }
  let qty = Math.floor(quantity * Math.pow(10, scale.amount)) / Math.pow(10, scale.amount)
  if (qty < Math.pow(10, -scale.amount)) qty = Math.pow(10, -scale.amount)
  return {
    price: parseFloat(price.toFixed(scale.price)),
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
  makerMode: boolean
  direction: "long" | "short"
}
// Returns ALL grid configs, not just enabled ones. Disabling a pair should
// stop new buy ladders but must not abandon existing held inventory (a
// pending sell representing a real position) — the tick loop needs to keep
// seeing disabled-but-still-holding pairs so it can close that inventory out.
// runGridTick/runGridTickMaker already skip building fresh ladders via their
// own `if (!gc.enabled) return` checks, so filtering here is unnecessary and
// was silently orphaning held positions on any pair you disabled.
export async function getGridConfigs(): Promise<GridConfig[]> {
  const rows = await db.select().from(gridConfigs)
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
    makerMode: r.makerMode,
    direction: (r.direction as "long" | "short") || "long",
  }))
}


export async function log(level: "info" | "trade" | "error", message: string, details?: unknown) {
  await db.insert(botLogs).values({
    level,
    message,
    details: details || null,
  })
}

export async function getActiveOrders(symbol?: string, timeframe?: string): Promise<GridOrder[]> {
  if (symbol && timeframe) {
    return db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe)))
  } else if (symbol) {
    return db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.symbol, symbol)))
  } else {
    return db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
  }
}

// Build the ladder: buy levels below current price across the lower half of
// the range. Sells are placed dynamically one spacing above each filled buy.



const GRID_STOP_LOSS_PCT = 0.05 // 5% adverse move triggers stop-loss

// Safety margin against liquidation, mirroring lib/exits.ts's approach for
// the trend engine: isolated-margin futures liquidate at roughly 1/leverage
// away from entry. A flat percentage stop that ignores leverage can end up
// set BEYOND where the exchange already force-liquidates at high leverage —
// meaning the bot's own stop never fires; forced liquidation does instead,
// at a worse price plus a penalty, with zero warning.
const GRID_LIQUIDATION_SAFETY_FACTOR = 0.75

function effectiveGridStopPct(leverage: number): number {
  const liquidationDistApprox = 1 / leverage
  return Math.min(GRID_STOP_LOSS_PCT, liquidationDistApprox * GRID_LIQUIDATION_SAFETY_FACTOR)
}

// Cancels other pending orders for this pair on the REAL exchange (not just
// the database) before marking them cancelled — otherwise any real resting
// order gets orphaned on MEXC while our records claim it's gone.
async function cancelOtherPendingOrders(active: GridOrder[], keepId: number): Promise<void> {
  const others = active.filter(x => x.id !== keepId && x.status === "pending")
  if (others.length === 0) return
  const realIds = others.filter(o => o.mexcOrderId).map(o => o.mexcOrderId!) as string[]
  if (realIds.length > 0) {
    try {
      await cancelOrders(realIds)
    } catch (err) {
      await log("error", `Grid stop-loss: failed cancelling ${realIds.length} real resting order(s) on exchange: ${dbErr(err)}`)
    }
  }
  await db.update(gridOrders).set({ status: "cancelled" }).where(inArray(gridOrders.id, others.map(x => x.id)))
}

async function checkGridStopLoss(cfg: BotConfig, gc: GridConfig, price: number, exchange?: ExchangeClient): Promise<boolean> {
  const active = await getActiveOrders(gc.symbol, gc.timeframe)
  
  // Check Long inventory
  for (const o of active.filter(x => x.side === "sell" && x.buyPrice != null && x.status === "pending")) {
    const adverse = (o.buyPrice! - price) / o.buyPrice!
    if (adverse >= effectiveGridStopPct(o.leverage)) {
      if (cfg.mode === "live" && exchange) { try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 4, volume: o.quantity, leverage: o.leverage }) } catch (e) {} }
      const grossPnl = (price - o.buyPrice!) * o.quantity
      const fees = (o.buyPrice! + price) * o.quantity * TAKER_FEE
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - (price * o.quantity * TAKER_FEE)}` }).where(eq(botConfig.id, 1))
      }
      const claimedLongStop = await db.update(gridOrders).set({ status: "filled" }).where(and(eq(gridOrders.id, o.id), eq(gridOrders.status, "pending"))).returning({ id: gridOrders.id })
      if (claimedLongStop.length === 0) return false
      await cancelOtherPendingOrders(active, o.id)
      await log("trade", `Grid ${o.symbol} STOP-LOSS closed @ ${price.toFixed(4)} | PnL ${(grossPnl - fees).toFixed(2)} USDT`)
      return true
    }
  }

  // Check Short inventory
  for (const o of active.filter(x => x.side === "buy" && x.buyPrice != null && x.status === "pending")) {
    const adverse = (price - o.buyPrice!) / o.buyPrice!
    if (adverse >= effectiveGridStopPct(o.leverage)) {
      if (cfg.mode === "live" && exchange) { try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 2, volume: o.quantity, leverage: o.leverage }) } catch (e) {} }
      const grossPnl = (o.buyPrice! - price) * o.quantity
      const fees = (o.buyPrice! + price) * o.quantity * TAKER_FEE
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - (price * o.quantity * TAKER_FEE)}` }).where(eq(botConfig.id, 1))
      }
      await cancelOtherPendingOrders(active, o.id)
      await db.update(gridOrders).set({ status: "filled" }).where(eq(gridOrders.id, o.id))
      await log("trade", `Grid ${o.symbol} SHORT STOP-LOSS closed @ ${price.toFixed(4)} | PnL ${(grossPnl - fees).toFixed(2)} USDT`)
      return true
    }
  }
  return false
}

export async function setupGrid(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, volatility?: VolatilityState, exchange?: ExchangeClient, startAtPrice = false): Promise<void> {
  const center = snap.price
  const configuredHalf = snap.atr * gc.rangeAtrMult
  const breakeven = center * 2 * TAKER_FEE
  const feeBasedMin = breakeven * gc.feeMarginMult
  const pctBasedMin = center * 0.005 // 0.5% floor — prevents zero-movement TP at high price magnitudes
  const minSpacing = Math.max(feeBasedMin, pctBasedMin)
  // GEOMETRIC SPACING: Widens gap between orders as price moves away from center.
  // Protects budget from deploying too fast during flash crashes/pumps.
  const bbWidth = snap.bbUpper - snap.bbLower
  const bbBaseSpacing = bbWidth / 4
  const maxSpacing = center * 0.02 // 2% cap — grids farther than this never fill (dead capital)
let baseSpacing = Math.min(Math.max(bbBaseSpacing, minSpacing), maxSpacing)
if ((gc as any).direction === "neutral") baseSpacing = Math.max(center * 0.006, minSpacing) // COMBO-DENSE
  const geomRatio = gc.direction === "neutral" ? 1.0 : 1.15 // COMBO-DENSE: uniform arithmetic spacing like Bitsgap
  const totalLevels = Math.max(1, Math.min(12, Math.floor(gc.levels / 2))) // Cap at 12 levels per side
  const effectiveLevels = gc.levels
  // Approximate half-range for DB logging
  let distAccum = 0
  for (let i = 1; i <= totalLevels; i++) distAccum += baseSpacing * Math.pow(geomRatio, i - 1)
  const effectiveHalf = Math.max(configuredHalf, distAccum)
  const lower = center - effectiveHalf
  const upper = center + effectiveHalf
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
  const notionalPerLevel = (budget / totalLevels) * gc.leverage
  
  // Liquidation Safety Check: Ensure leverage isn't so high that MEXC liquidates 
  // the position before our 5% GRID_STOP_LOSS_PCT can trigger.
  // MEXC liquidates at roughly 100% / leverage adverse move.
  const liqDistancePct = 1.0 / gc.leverage
  if (liqDistancePct <= GRID_STOP_LOSS_PCT * 1.5) {
    await log("error", `Grid ${gc.symbol}: Refusing to build grid. Leverage ${gc.leverage}x is too high. Liquidation distance (${(liqDistancePct*100).toFixed(1)}%) is too close to stop-loss (${(GRID_STOP_LOSS_PCT*100).toFixed(1)}%). Reduce leverage to <= ${Math.floor(1.0 / (GRID_STOP_LOSS_PCT * 1.5))}x.`)
    await db.update(gridConfigs).set({ paused: true }).where(eq(gridConfigs.id, gc.id))
    return
  }

  const isNeutral = gc.direction === "neutral"
const isShort = !isNeutral && (gc.direction === "short" || (gc as any)._autoSide === "short")
const orders: any[] = []
  for (let i = 1; i <= totalLevels; i++) {
    // Calculate cumulative distance for geometric spacing
    const dist = geomRatio === 1 ? baseSpacing * i : baseSpacing * (Math.pow(geomRatio, i) - 1) / (geomRatio - 1)
    const orderPrice = isShort ? center + dist : center - dist
    if (orderPrice <= 0) continue
    orders.push({
      symbol: gc.symbol,
      timeframe: gc.timeframe,
      leverage: gc.leverage,
      spacing: baseSpacing, // Base spacing stored, ratio applied dynamically
      levelIndex: i,
      side: isShort ? "sell" : "buy",
      price: orderPrice,
      quantity: notionalPerLevel / orderPrice,
      status: "pending" as const,
})
}
if (isNeutral) {
for (let i = 1; i <= totalLevels; i++) {
const dist = geomRatio === 1 ? baseSpacing * i : baseSpacing * (Math.pow(geomRatio, i) - 1) / (geomRatio - 1)
const orderPrice = center + dist
if (orderPrice <= 0) continue
orders.push({
symbol: gc.symbol,
timeframe: gc.timeframe,
leverage: gc.leverage,
spacing: baseSpacing,
levelIndex: i,
side: "sell",
price: orderPrice,
quantity: notionalPerLevel / orderPrice,
status: "pending" as const,
})
}
}
if (volatility && volatility.surge) {
    await log("info", `Grid ${gc.symbol}: ${volatility.reason}`)
  }
  if (cfg.mode === "live") {
    for (const ord of orders) {
      try {
        const side = isShort ? (ord.side === "sell" ? 3 : 2) : (ord.side === "sell" ? 4 : 1)
        const res: any = await placePostOnlyOrder({
          symbol: ord.symbol,
          side,
          volume: ord.quantity,
          price: ord.price,
          leverage: ord.leverage,
        })
        const oid = extractOrderId(res)
        await db.insert(gridOrders).values({ ...ord, mexcOrderId: oid, exchangeStatus: "new" })
        await log("info", `Grid ${gc.symbol}: resting ${ord.side} @ ${ord.price.toFixed(6)} id=${oid}`)
      } catch (err) {
        await log("error", `Grid ${gc.symbol}: ${ord.side} rejected @ ${ord.price.toFixed(6)}: ${dbErr(err)}`)
      }
    }
  } else {
    if (orders.length > 0) await db.insert(gridOrders).values(orders)
  }
  await db.update(botConfig).set({ gridCenter: center, gridLower: lower, gridUpper: upper, gridSpacing: baseSpacing, gridEffectiveLevels: effectiveLevels, gridPaused: false }).where(eq(botConfig.id, 1))
  await log("info", `Grid set up: ${orders.length} ${isShort ? "sell" : "buy"} GEOMETRIC levels between ${lower.toFixed(2)} and ${upper.toFixed(2)} | base spacing ${baseSpacing.toFixed(6)} (ratio ${geomRatio}) | budget ${budget.toFixed(2)} USDT x${gc.leverage}`)
  // Geometric spacing applied successfully.
}

export async function teardownGrid(cfg: BotConfig, currentPrice: number | null): Promise<void> {
  const active = await getActiveOrders(cfg.symbol, cfg.timeframe)

  // Maker: cancel real resting orders on the exchange first so we never leave
  // orphaned post-only orders behind after a manual stop.
  const makerIds = active.filter((o) => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
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
): Promise<boolean> {
  // ATOMIC CLAIM: only one concurrent caller can ever win this update (only
  // succeeds if the row is still "pending"). Without this, overlapping
  // triggers (duplicate WS events, overlapping ticks, or old/new instances
  // briefly running side by side during a deploy) can all process the same
  // fill, producing duplicate trade records and, in live mode, duplicate
  // real market orders for a single position.
  const claimed = await db.update(gridOrders)
    .set({ status: "filled", filledAt: sql`NOW()` })
    .where(and(eq(gridOrders.id, order.id), eq(gridOrders.status, "pending")))
    .returning({ id: gridOrders.id })
  if (claimed.length === 0) return false // another process already claimed this fill

  if (cfg.mode === "live") {
    try {
      if (exchange) { const r = roundForMexc(order.symbol, order.price, order.quantity); await exchange.placeMarketOrder({ symbol: order.symbol, side: 4, volume: r.quantity, leverage: order.leverage }) }
    } catch (err) {
      await log("error", `LIVE grid sell failed: ${err instanceof Error ? err.message : String(err)}`)
      // Real sell failed on the exchange. Revert the claim so a later,
      // legitimate retry can still process this fill.
      await db.update(gridOrders).set({ status: "pending" }).where(eq(gridOrders.id, order.id))
      // Real sell failed on the exchange (e.g. position already closed
      // manually, or a transient API error). The caller must NOT re-arm a
      // fresh buy in this case — that was silently happening before and
      // caused the same doomed retry every single tick.
      return false
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

  // Order already marked as filled during atomic claim above

  // The buy fee was deducted when the rung filled. Add only gross PnL minus
  // the sell fee here, otherwise the buy fee is charged twice.
  if (cfg.mode === "paper") {
    await db
      .update(botConfig)
      .set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` })
      .where(eq(botConfig.id, 1))
  }

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
  return true
}

// Maker settle: the resting post-only sell already executed on the exchange,
// so we do NOT place any order here — we only record the trade and books.
async function settleMakerSell(order: GridOrder, exitPrice: number, cfg: BotConfig): Promise<void> {
  // ATOMIC CLAIM: Prevent duplicate settlement
  const claimed = await db.update(gridOrders)
    .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
    .where(and(eq(gridOrders.id, order.id), eq(gridOrders.status, "pending")))
    .returning({ id: gridOrders.id })
  
  if (claimed.length === 0) return // Already claimed by another process

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

  // Order already marked as filled during atomic claim

  if (cfg.mode === "paper") {
    await db
      .update(botConfig)
      .set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` })
      .where(eq(botConfig.id, 1))
  }

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
  if (cfg.mode === "paper") {
    await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - sellFee}` }).where(eq(botConfig.id, 1))
  }

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModel()
      // [non-grid ML] grid fills no longer train the model
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log("trade", `Grid ${order.symbol} (maker) ${reason.toUpperCase()} closed @ ${exitPrice.toFixed(6)} (bought ${buyPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
}

// Maker SHORT stop-loss settlement: cancel resting buy-to-close, then close short at market.
async function settleMakerShortStopLoss(order: GridOrder, exitPrice: number, cfg: BotConfig, reason: "stop-loss" | "max-hold"): Promise<void> {
if (order.mexcOrderId) {
try {
await cancelOrders([order.mexcOrderId])
} catch (err) {
await log("error", `Grid ${order.symbol} (maker short): failed cancelling resting buy before ${reason}: ${dbErr(err)}`)
}
}
try {
await makerMarketOrder({ symbol: order.symbol, side: 2, volume: order.quantity, leverage: order.leverage })
} catch (err) {
await log("error", `Grid ${order.symbol} (maker short): ${reason} market close FAILED, will retry next tick: ${dbErr(err)}`)
return
}
const entryPrice = order.buyPrice ?? order.price
const sizeUsdt = (entryPrice * order.quantity) / order.leverage
const grossPnl = (entryPrice - exitPrice) * order.quantity
const fees = (entryPrice + exitPrice) * order.quantity * TAKER_FEE
const netPnl = grossPnl - fees
const [trade] = await db
.insert(trades)
.values({
symbol: order.symbol, side: "short", entryPrice, exitPrice,
sizeUsdt, leverage: order.leverage, pnl: netPnl, fees,
exitReason: reason, strategy: "grid", live: cfg.mode === "live",
})
.returning({ id: trades.id })
await db.update(gridOrders).set({ status: "filled", exchangeStatus: "cancelled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, order.id))
if (cfg.mode === "paper") {
  await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - (exitPrice * order.quantity * TAKER_FEE)}` }).where(eq(botConfig.id, 1))
}
if (trade && order.entryFeatures) {
try {
const model = await loadModel()
// [non-grid ML] grid fills no longer train the model
} catch (err) {
await log("error", `Grid ${order.symbol} (maker short) ML update failed: ${dbErr(err)}`)
}
}
await log("trade", `Grid ${order.symbol} (maker short) ${reason.toUpperCase()} closed @ ${exitPrice.toFixed(6)} (shorted ${entryPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
}

async function runGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): Promise<void> {
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTickMaker(cfg, gc, snap, regime) }
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  const volatility = detectVolatilitySurge(gc.symbol, snap)
  const gridAdxThreshold = 32 // Grids handle mild trends better than single positions
const paused = gc.autoPause && snap.adx >= gridAdxThreshold

  const gridConfigRow = await db.select().from(gridConfigs).where(
    and(eq(gridConfigs.symbol, gc.symbol), eq(gridConfigs.timeframe, gc.timeframe))
  ).limit(1)

  if (gridConfigRow.length > 0 && gridConfigRow[0].paused !== paused) {
    await db.update(gridConfigs).set({ paused }).where(eq(gridConfigs.id, gridConfigRow[0].id))
    if (paused) {
      const restingBuys = active.filter((o) => o.side === "buy")
      if (restingBuys.length > 0) {
        try {
          const liveIds = restingBuys.filter(o => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
          if (liveIds.length > 0) await cancelOrders(liveIds)
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
            const toCancel = (gc.direction as string) === "neutral" ? active : restingBuys
const liveIds = toCancel.filter(o => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
if (liveIds.length > 0) await cancelOrders(liveIds)
await db.update(gridOrders)
.set({ status: "cancelled", exchangeStatus: "cancelled" })
.where(inArray(gridOrders.id, toCancel.map((o) => o.id)))
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
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance}` /* MARGIN DEDUCTION REMOVED FOR PAPER TRADING */ }).where(eq(botConfig.id, 1))

      const sellPrice = fillPrice + (snap.atr * gc.rangeAtrMult)
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
          spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell",
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
            spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy",
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

export async function runGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange?: ExchangeClient, candles?: Candle[]): Promise<void> {
  // Maker mode (live + enabled symbol): use the real-order polling path and
  // skip the entire virtual-fill engine below.
  if (cfg.mode === "live" && isMakerSymbol(gc)) {
    return runGridTickMaker(cfg, gc, snap, regime)
  }

  const active = await getActiveOrders(gc.symbol, gc.timeframe)
  if (await checkGridStopLoss(cfg, gc, snap.price, exchange)) return
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTick(cfg, gc, snap, exchange) }

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
let hi = price, lo = price
if (candles && candles.length > 0) {
const cur = candles[candles.length - 1] // forming candle: includes the current spike
hi = Math.max(price, cur.high)
lo = Math.min(price, cur.low)
}
  let spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
  const gridAdxThreshold = 32 // Grids handle mild trends better than single positions
const paused = gc.autoPause && snap.adx >= gridAdxThreshold
  
  // Phantom trend order removed

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

  // Auto-recenter: if price has drifted far, OR if Bollinger Bands have squeezed tighter, rebuild ladder
  const allPrices = active.map(o => o.price)
  if (allPrices.length > 0) {
    const minOrderPrice = Math.min(...allPrices)
    const maxOrderPrice = Math.max(...allPrices)
    const priceDrift = Math.min(
      Math.abs(price - minOrderPrice) / price * 100,
      Math.abs(price - maxOrderPrice) / price * 100
    )
    
    // Dynamic Bollinger Adjustment: If BB width is 40% narrower than our current spacing, rebuild tighter
    const currentBbWidth = snap.bbUpper - snap.bbLower
    const currentSpacing = active.find(o => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
    const needsTighten = false // Disabled: BB squeeze causes infinite cancel/rebuild loops in low vol

    // If price is >15% away, OR the grid is too wide for the current volatility
    // NEUTRAL DRIFT FIX: Only recenter if price escapes the ladder entirely
let shouldRecenter = false;
if ((gc as any).direction === "neutral") {
  const highestSell = active.filter(o => o.side === "sell").reduce((max, o) => Math.max(max, o.price), 0);
  const lowestBuy = active.filter(o => o.side === "buy").reduce((min, o) => Math.min(min, o.price), Infinity);
  shouldRecenter = price > highestSell * 1.02 || price < lowestBuy * 0.98;
} else {
  shouldRecenter = priceDrift > 15 || needsTighten;
}
if (shouldRecenter) {
      await log("info", `Grid ${gc.symbol}: price drifted ${priceDrift.toFixed(1)}% from orders. Recentering ladder at ${price.toFixed(4)}.`)
      // Cancel ALL pending orders — if price crashed >40%, sells are hopeless
      const cancelAll = shouldRecenter || (gc.direction as string) === "neutral" // COMBO-FIX: neutral rebuilds wipe both sides
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
  const sells = active.filter((o) => o.side === "sell" && hi >= o.price)
for (const o of sells) {
if (o.buyPrice == null && (gc as any).direction === "neutral") {
await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
const closePrice = o.price - spacing
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, entryFeatures: { ...snap.features, sideLong: -1 }, status: "pending" })
await log("trade", `Grid ${o.symbol} COMBO short sell @ ${o.price.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
continue
}
if (o.buyPrice == null && gc.direction === "neutral") {
await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
const closePrice = o.price - spacing
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, entryFeatures: { ...snap.features, sideLong: -1 }, status: "pending" })
await log("trade", `Grid ${o.symbol} COMBO short sell @ ${o.price.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
continue
}
const sold = await settleGridSell(o, o.price, cfg, "tp", exchange)
    // Re-arm the buy at its original level — only if the sell actually
    // succeeded. Re-arming after a failed sell (e.g. the position no longer
    // existed on the exchange) just recreates the same doomed order forever.
    if (sold && o.buyPrice != null) {
      await db.insert(gridOrders).values({
        symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
        spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy",
        price: o.buyPrice, quantity: o.quantity, status: "pending",
      })
    }
  }

  // 2) Buy fills: price dropped to/below a pending buy level (skip when paused)
  if (!paused) {
    const buys = active.filter((o) => o.side === "buy" && lo <= o.price)
for (const o of buys) {
if (o.buyPrice != null && (gc as any).direction === "neutral") {
  // RACE-FIX: Re-check order status before processing (prevents double-fill)
  const fresh = await db.select({ status: gridOrders.status }).from(gridOrders).where(eq(gridOrders.id, o.id))
  if (fresh[0]?.status !== "pending") continue
  
  const entry = o.buyPrice
  const grossPnl = (entry - o.price) * o.quantity
  const fees = (entry + o.price) * o.quantity * TAKER_FEE
  const netPnl = grossPnl - fees
  await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: entry, exitPrice: o.price, sizeUsdt: (entry * o.quantity) / o.leverage, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: false })
await log("trade", `Grid ${o.symbol} COMBO short closed @ ${o.price.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: entry, quantity: o.quantity, status: "pending" })
continue
}
if (o.buyPrice != null && gc.direction === "neutral") {
const entry = o.buyPrice
const grossPnl = (entry - o.price) * o.quantity
const fees = (entry + o.price) * o.quantity * TAKER_FEE
const netPnl = grossPnl - fees
await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: entry, exitPrice: o.price, sizeUsdt: (entry * o.quantity) / o.leverage, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
await log("trade", `Grid ${o.symbol} COMBO short closed @ ${o.price.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: entry, quantity: o.quantity, status: "pending" })
continue
}
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
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance}` /* MARGIN DEDUCTION REMOVED FOR PAPER TRADING */ }).where(eq(botConfig.id, 1))

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
        spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell",
        price: o.price + spacing, quantity: o.quantity, buyPrice: o.price,
        // ON CONFLICT DO NOTHING handled by database unique index
        entryFeatures: { ...snap.features, sideLong: 1 },
        status: "pending",
      })

      await log("trade", `Grid ${o.symbol} buy @ ${o.price.toFixed(4)} | sell placed @ ${(o.price + (snap.atr * gc.rangeAtrMult)).toFixed(4)}`)
    }
  }
}


async function handleShortGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  if (active.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, undefined)
    return
  }
  const spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
  for (const o of active.filter(o => o.side === "sell" && o.mexcOrderId)) {
    const st: any = await fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    if (Number(st.state) === 3) {
      const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const closePrice = fillPrice - (snap.atr * gc.rangeAtrMult)
      try {
        const res: any = await placePostOnlyOrder({ symbol: o.symbol, side: 2, price: closePrice, volume: o.quantity, leverage: o.leverage })
        const bid = extractOrderId(res)
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: fillPrice, mexcOrderId: bid, exchangeStatus: "new", status: "pending" })
        await log("trade", `Short ${o.symbol} sell filled @ ${fillPrice.toFixed(6)} | buy to close @ ${closePrice.toFixed(6)}`)
      } catch (err) {
        await log("error", `Short ${o.symbol} buy placement failed: ${dbErr(err)}`)
      }
    } else if ([4,5].includes(Number(st.state))) {
      await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }
  for (const o of active.filter(o => o.side === "buy" && o.mexcOrderId)) {
    const st: any = await fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    if (Number(st.state) === 3) {
      const exitPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      const sellPrice = exitPrice + (snap.atr * gc.rangeAtrMult)
      const grossPnl = sellPrice - exitPrice
      const fees = (sellPrice + exitPrice) * o.quantity * TAKER_FEE
      const netPnl = grossPnl - fees
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
      }
      await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: sellPrice, exitPrice, sizeUsdt: (sellPrice * o.quantity) / o.leverage, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
      await log("trade", `Short ${o.symbol} closed @ ${exitPrice.toFixed(6)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
      try {
        const res: any = await placePostOnlyOrder({ symbol: o.symbol, side: 3, price: sellPrice, volume: o.quantity, leverage: o.leverage })
        const sid = extractOrderId(res)
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: sellPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
      } catch (err) {
        await log("error", `Short ${o.symbol} re-arm sell failed: ${dbErr(err)}`)
      }
    } else if ([4,5].includes(Number(st.state))) {
      await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }
  const pendingSells = (await getActiveOrders(gc.symbol, gc.timeframe)).filter(o => o.side === "sell")
  if (pendingSells.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, undefined)
  }
}

async function handleShortGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, exchange?: ExchangeClient): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  if (active.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, exchange)
    return
  }
  const spacing = active.find(o => o.spacing)?.spacing ?? snap.atr * gc.rangeAtrMult
  let price = snap.price
  try { if (exchange) { const t = await exchange.fetchTicker(gc.symbol); if (t?.lastPrice) price = t.lastPrice } } catch {}
  for (const o of active.filter(o => o.side === "sell")) {
    if (o.mexcOrderId) {
      const st: any = await fetchOrderStatus(o.mexcOrderId)
      if (st && Number(st.state) === 3) {
        const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
        await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
        const closePrice = fillPrice - (snap.atr * gc.rangeAtrMult)
        if (cfg.mode === "live") {
          try {
            const res: any = await placePostOnlyOrder({ symbol: o.symbol, side: 2, price: closePrice, volume: o.quantity, leverage: o.leverage })
            const bid = extractOrderId(res)
            await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: fillPrice, mexcOrderId: bid, exchangeStatus: "new", status: "pending" })
          } catch (err) { await log("error", `Short buy close failed: ${dbErr(err)}`) }
        } else {
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, status: "pending" })
        }
        await log("trade", `Short ${o.symbol} sell filled @ ${fillPrice.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
      }
    } else if (price >= o.price) {
      if (cfg.mode === "live" && exchange) {
        try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 3, volume: o.quantity, leverage: o.leverage }) } catch (err) { await log("error", `Short open failed: ${dbErr(err)}`) }
      }
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const closePrice = o.price - (snap.atr * gc.rangeAtrMult)
      await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, status: "pending" })
      await log("trade", `Short ${o.symbol} sell @ ${o.price.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
    }
  }
  for (const o of active.filter(o => o.side === "buy")) {
    if (o.mexcOrderId) {
      const st: any = await fetchOrderStatus(o.mexcOrderId)
      if (st && Number(st.state) === 3) {
        const exitPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
        const sellPrice = exitPrice + (snap.atr * gc.rangeAtrMult)
        const grossPnl = sellPrice - exitPrice
        const fees = (sellPrice + exitPrice) * o.quantity * TAKER_FEE
        const netPnl = grossPnl - fees
        await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
        if (cfg.mode === "paper") {
          await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
        }
        await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: sellPrice, exitPrice, sizeUsdt: (sellPrice * o.quantity) / o.leverage, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
        await log("trade", `Short ${o.symbol} closed @ ${exitPrice.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
        const newSellPrice = exitPrice + (snap.atr * gc.rangeAtrMult)
        if (cfg.mode === "live") {
          try {
            const res: any = await placePostOnlyOrder({ symbol: o.symbol, side: 3, price: newSellPrice, volume: o.quantity, leverage: o.leverage })
            const sid = extractOrderId(res)
            await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: newSellPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
          } catch (err) { await log("error", `Short re-arm sell failed: ${dbErr(err)}`) }
        } else {
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: newSellPrice, quantity: o.quantity, status: "pending" })
        }
      }
    } else if (price <= o.price) {
      const sellPrice = o.price + (snap.atr * gc.rangeAtrMult)
      if (cfg.mode === "live" && exchange) {
        try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 2, volume: o.quantity, leverage: o.leverage }) } catch (err) { await log("error", `Short close failed: ${dbErr(err)}`) }
      }
      const grossPnl = sellPrice - o.price
      const fees = (sellPrice + o.price) * o.quantity * TAKER_FEE
      const netPnl = grossPnl - fees
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
      }
      await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: sellPrice, exitPrice: o.price, sizeUsdt: (sellPrice * o.quantity) / o.leverage, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
      await log("trade", `Short ${o.symbol} closed @ ${o.price.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
      const newSellPrice = o.price + (snap.atr * gc.rangeAtrMult)
      if (cfg.mode === "live") {
        try {
          const res: any = await placePostOnlyOrder({ symbol: o.symbol, side: 3, price: newSellPrice, volume: o.quantity, leverage: o.leverage })
          const sid = extractOrderId(res)
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: newSellPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
        } catch (err) { await log("error", `Short re-arm sell failed: ${dbErr(err)}`) }
      } else {
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, side: "sell", price: newSellPrice, quantity: o.quantity, status: "pending" })
      }
    }
  }
  const pendingSells = (await getActiveOrders(gc.symbol, gc.timeframe)).filter(o => o.side === "sell")
  if (pendingSells.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, exchange)
  }
}
export async function gridUnrealizedPnl(currentPrice: number, symbol?: string, timeframe?: string): Promise<number> {
  let holding: GridOrder[]
  if (symbol && timeframe) {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell"), eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe)))
  } else if (symbol) {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell"), eq(gridOrders.symbol, symbol)))
  } else {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell")))
  }
  const longPnl = holding.reduce((acc, o) => acc + (currentPrice - (o.buyPrice ?? o.price)) * o.quantity, 0)
const act = await getActiveOrders(symbol, timeframe)
const shortPnl = act.filter(o => o.side === "buy" && o.buyPrice != null).reduce((acc, o) => acc + ((o.buyPrice ?? 0) - currentPrice) * o.quantity, 0)
return longPnl + shortPnl
}

export async function syncExchangeState() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    console.log(`[Reconcile] Syncing state for ${configs.length} enabled pairs...`)
    
    for (const c of configs) {
      try {
        const dbOrders = await db.select().from(gridOrders).where(
          and(eq(gridOrders.symbol, c.symbol), eq(gridOrders.status, "pending"))
        )
        
        for (const dbOrder of dbOrders) {
          // Skip orders synced in the last 2 hours — trust MEXC open_orders
          if ((dbOrder as any).syncedAt) {
            const syncAge = Date.now() - new Date((dbOrder as any).syncedAt).getTime()
            if (syncAge < 2 * 60 * 60 * 1000) continue
          }
          // Skip orders created or updated in the last 10 minutes (grace period for synced orders)
          const orderAge = Date.now() - new Date(dbOrder.createdAt).getTime()
          if (orderAge < 10 * 60 * 1000) continue
          
          if (dbOrder.mexcOrderId) {
            try {
              const st: any = await fetchOrderStatus(dbOrder.mexcOrderId as string)
              if (st) {
                const state = Number(st.state)
                // MEXC States: 1=Unfilled, 2=PartiallyFilled, 3=Filled, 4=Cancelled
                if (state === 3 || state === 4) {
                  const newStatus = state === 3 ? "filled" : "cancelled"
                  // LOUD LOG: Alert that a mismatch was found and corrected
                  await log("error", `[Reconcile] DRIFT DETECTED: ${c.symbol} DB Order ${dbOrder.mexcOrderId} is ${newStatus} on MEXC but pending in DB. Auto-correcting.`)
                  await db.update(gridOrders).set({ 
                    status: newStatus, 
                    exchangeStatus: newStatus, 
                    filledAt: state === 3 ? sql`NOW()` : null 
                  }).where(eq(gridOrders.id, dbOrder.id))
                }
              }
            } catch (e) {
              // Silently skip individual order status failures to keep the loop moving
            }
            // 100ms delay to avoid rate limits during sync
            await new Promise(r => setTimeout(r, 100))
          }
        }
      } catch (e) {
        console.error(`[Reconcile] Failed for ${c.symbol}:`, e)
      }
    }
    console.log("[Reconcile] State sync complete.")
  } catch (e) {
    console.error("[Reconcile] Failed to sync exchange state:", e)
  }
}

let _lastRiskHaltState: string | null = null
let _tickInProgress = false
// Tick orchestration: data → features → ML-gated signal → exit management →
// paper/live execution → model update → persistence.

import { db, pool } from "./db"
import {
  botConfig,
  positions,
  trades,
  equitySnapshots,
  botLogs,
  gridOrders,
  classifierDecisions,
  type BotConfig,
  type Position,
} from "./db/schema"
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm"
import { type Candle, fetchDeals, computeTakerFlow } from "./mexc/public"
import { getExchangeClient, type Exchange } from "./exchange"
import { classifyLorentzian, combineConfirmation } from "./lorentzian"
import { computeSnapshot, type FeatureVector, type IndicatorSnapshot } from "./indicators"
import { loadModelFor, trainOnTrade, gateEntry, MODEL_IDS } from "./ml"
import { evaluateEntry, isOppositeSignal, detectRegime } from "./strategy"
import { getActiveOrders, runGridTick, gridUnrealizedPnl, getGridConfigs, type GridConfig } from "./grid"
import { detectFlashFade, executeFlashFade } from "./flash-fade"
import { maybeRunGridAiAdvisorAuto } from "./ai-grid-advisor"
import { analyzeTradesForMarket, applyRecommendations } from "./ai-advisor"
import { computeInitialStops, evaluateExit } from "./exits"
import { MexcWebSocketManager, livePrices } from './mexc/ws';

import {
  evaluatePortfolioRisk,
  isTradingHalted,
  canOpenNewPosition,
  marginBudgetRemaining,
  getRiskState,
} from "./risk-manager"
import { evaluateScalpSignal } from "./trend-scalper"
import { buildAwareness, decide } from "./awareness"

// Net grid inventory for a symbol/timeframe. Open inventory = pending orders
// that carry a paired entry (buyPrice): a pending sell with buyPrice is an open
// LONG (buy filled, sell is the TP exit); a pending buy with buyPrice is an open
// SHORT (short filled, buy is the close). This mirrors checkGridStopLoss.
async function computeGridInventory(symbol: string, timeframe: string, markPrice: number) {
  const active = await getActiveOrders(symbol, timeframe)
  let longQty = 0, longNotional = 0, shortQty = 0, shortNotional = 0
  for (const o of active) {
    if (o.buyPrice == null) continue
    if (o.side === "sell") { longQty += o.quantity; longNotional += o.quantity * o.buyPrice }
    else if (o.side === "buy") { shortQty += o.quantity; shortNotional += o.quantity * o.buyPrice }
  }
  const netQty = longQty - shortQty
  const netExposure = longNotional - shortNotional
  let avgEntry: number | null = null
  if (longQty > 0) avgEntry = longNotional / longQty
  else if (shortQty > 0) avgEntry = shortNotional / shortQty
  const unrealizedPnl = avgEntry != null ? (markPrice - avgEntry) * netQty : 0
  return { netExposure, avgEntry, unrealizedPnl }
}
import { checkExposureGate } from "./exposure"
import { evaluateAdvancedEntry, type AdvancedConfig, cvdRollingStats } from "./advanced-strategy"

const TAKER_FEE = 0.0002 // 0.02%

// Symbol format utilities - converts BTC_USDT to BTCUSDT for MEXC API
function toExchangeSymbol(symbol: string): string {
  // MEXC futures uses underscores in symbols (e.g., RE_USDT, BTC_USDT)
  // Return the symbol as-is, preserving the underscore
  return symbol;
}

function toDbSymbol(symbol: string): string {
  return symbol.replace(/\//g, "_");
}

function advancedConfigFromBot(cfg: BotConfig): AdvancedConfig {
  return {
    enabled: cfg.advancedEnabled,
    mtfEnabled: cfg.advancedMtfEnabled,
    htfTimeframe: cfg.advancedHtfTimeframe,
    htfEmaFast: cfg.advancedHtfEmaFast,
    htfEmaSlow: cfg.advancedHtfEmaSlow,
    mtfMinAlignment: cfg.advancedMtfMinAlignment,
    smartMoneyEnabled: cfg.advancedSmartMoneyEnabled,
    fundingLongThreshold: cfg.advancedFundingLongThreshold,
    fundingShortThreshold: cfg.advancedFundingShortThreshold,
    oiDeltaThresholdPct: cfg.advancedOiDeltaThresholdPct,
    cvdZThreshold: cfg.advancedCvdZThreshold,
    dynamicSizingEnabled: cfg.advancedDynamicSizingEnabled,
    baseRiskPct: cfg.advancedBaseRiskPct,
    maxRiskPct: cfg.advancedMaxRiskPct,
    confidenceFloor: cfg.advancedConfidenceFloor,
    maxPositionPct: cfg.advancedMaxPositionPct,
  }
}

function lorentzianOptions(cfg: BotConfig) {
  return {
    neighbors: cfg.lorentzianNeighbors,
    lookback: cfg.lorentzianLookback,
    confidenceThreshold: cfg.lorentzianConfidenceThreshold,
    useVolatilityFilter: cfg.lorentzianUseVolatilityFilter,
    useRegimeFilter: cfg.lorentzianUseRegimeFilter,
    regimeThreshold: cfg.lorentzianRegimeThreshold,
    useKernelFilter: cfg.lorentzianKernelFilter,
  }
}

async function resolveClassifierOutcomes(symbol: string, timeframe: string, candles: Candle[]) {
  const pending = await db.select().from(classifierDecisions).where(and(
    eq(classifierDecisions.symbol, symbol),
    eq(classifierDecisions.timeframe, timeframe),
    isNull(classifierDecisions.resolvedAt),
  ))
  const candleIndex = new Map(candles.map((candle, index) => [candle.time, index]))
  for (const decision of pending) {
    const index = candleIndex.get(decision.candleTime)
    if (index == null || index + 4 >= candles.length) continue
    const future = candles[index + 4].close
    const outcomeDirection = future > decision.entryPrice ? "long" : future < decision.entryPrice ? "short" : "neutral"
    const outcomeReturn = (future - decision.entryPrice) / decision.entryPrice
    await db.update(classifierDecisions).set({
      outcomeDirection,
      outcomeReturn,
      returnUnit: "percent",
      outcomeCorrectLogistic: decision.logisticAllowed && decision.candidateDirection === outcomeDirection,
      outcomeCorrectLorentzian: decision.lorentzianDirection === outcomeDirection,
      resolvedAt: new Date(),
    }).where(eq(classifierDecisions.id, decision.id))
  }
}

async function log(level: "info" | "trade" | "error" | "warn", message: string, details?: unknown) {
  try {
    await db.insert(botLogs).values({
      level,
      message,
      details: details || null,
    })
  } catch (error) {
    console.error("Failed to insert log:", error)
  }
}

export async function getConfig(): Promise<BotConfig> {
  const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1))
  if (rows.length === 0) throw new Error("Bot config not found")
  return rows[0]
}

export async function getOpenPositions(): Promise<Position[]> {
  return db.select().from(positions).where(eq(positions.status, "open"))
}

async function getOpenPosition(symbol?: string, timeframe?: string): Promise<Position | null> {
  const rows = await getOpenPositions()
  return rows.find((p) => (!symbol || p.symbol === symbol) && (!timeframe || p.timeframe === timeframe)) ?? null
}

export function unrealizedPnl(position: Position, markPrice: number): number {
  const dir = position.side === "long" ? 1 : -1
  const qty = position.remainingQuantity ?? position.quantity
  return (markPrice - position.entryPrice) * dir * qty
}

// Reconcile DB open positions against the exchange's actual open positions.
// If a position is no longer open on MEXC (liquidated, manually closed, or
// exchange-side stop), mark it closed in the DB so the UI and risk layer stop
// treating it as live exposure. Only runs in live mode; a failed MEXC read is
// treated as "unknown" and skipped, never as "all closed".
function normalizeSymbol(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
}

async function reconcilePositions(cfg: BotConfig): Promise<void> {
  if (cfg.mode !== "live") return
  try {
    const mexPositions = await getExchangeClient(cfg.exchange as Exchange).getOpenPositions()
    const mexSymbols = new Set(mexPositions.map((p) => normalizeSymbol(p?.symbol ?? "")))
    const dbOpen = await getOpenPositions()
    for (const pos of dbOpen) {
      if (!mexSymbols.has(normalizeSymbol(pos.symbol))) {
        await db.update(positions).set({ status: "closed", closedAt: sql`NOW()` }).where(eq(positions.id, pos.id))
        await log("info", `Reconciled: ${pos.symbol} ${pos.side} no longer open on MEXC — marked closed in DB`)
      }
    }
  } catch (err) {
    await log("error", `Reconciliation skipped (MEXC read failed): ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function openPosition(
  cfg: BotConfig,
  direction: "long" | "short",
  snap: IndicatorSnapshot,
  confidence: number,
  features: FeatureVector,
  strategy: "trend" | "range" | "webhook" | "scalp" = "trend",
  opts?: { sizeUsdtOverride?: number; stopLoss?: number; takeProfit?: number },
): Promise<number> {
  // ── Portfolio risk gate ── never ADD risk while halted / over caps.
  if (isTradingHalted() || !canOpenNewPosition()) {
    const rs = getRiskState()
    await log(
      "info",
      `Entry blocked by risk layer (${direction} ${cfg.symbol}): ${rs?.reasons.join("; ") || "max open positions reached"}`,
    )
    return 0
  }

  const price = snap.price

  // Determine SL/TP first — risk-based sizing needs the stop distance.
  // Explicit overrides (scalper) win; otherwise strategy default.
  let stopLoss: number | null = null
  let takeProfit: number | null = null
  let rangeTarget: number | null = null
  // Apply overrides independently.
  if (opts?.stopLoss != null) stopLoss = opts.stopLoss
  if (opts?.takeProfit != null) takeProfit = opts.takeProfit
  if (strategy === "range") {
    // Mean-reversion targets — TP at the middle of the range, tight SL just
    // beyond the range boundary (breakout = premise dead).
    rangeTarget = snap.bbMiddle
    if (takeProfit == null) takeProfit = snap.bbMiddle
    if (stopLoss == null) stopLoss = direction === "long" ? price - snap.atr * 1.0 : price + snap.atr * 1.0
  } else {
    const stops = computeInitialStops(direction, price, snap.atr, cfg)
    if (stopLoss == null) stopLoss = stops.stopLoss
    if (takeProfit == null) takeProfit = stops.takeProfit
  }

  // Effective margin for this position: honor a risk-based size override when
  // provided (trend scalper), but never below a small floor or above the
  // configured size AND the remaining margin budget.
  const MIN_MARGIN_USDT = 5
  const budget = marginBudgetRemaining()
  let sizeUsdt = cfg.positionSizeUsdt

  if (opts?.sizeUsdtOverride != null && opts.sizeUsdtOverride > 0) {
    sizeUsdt = Math.min(opts.sizeUsdtOverride, sizeUsdt)
  }
  sizeUsdt = Math.min(sizeUsdt, budget)
  if (sizeUsdt < MIN_MARGIN_USDT) {
    await log(
      "info",
      `Entry blocked by margin cap (${direction} ${cfg.symbol}): only ${budget.toFixed(2)} USDT margin budget remaining`,
    )
    return 0
  }

  // ── Cross-strategy exposure gate ──
  const proposedNotional = sizeUsdt * cfg.leverage
  const equity = (getRiskState()?.equity ?? cfg.paperBalance ?? 0) || 1
  const exposure = await checkExposureGate(cfg.symbol, direction, proposedNotional, equity)
  if (!exposure.allowed) {
    await log("info", `Entry blocked by exposure gate (${direction} ${cfg.symbol}): ${exposure.reason}`)
    return 0
  }

  const quantity = (sizeUsdt * cfg.leverage) / price

  // Effective fill values. In paper mode these stay at the intended price/qty.
  // In live mode we place the order AND confirm the actual fill, so the DB
  // records what really executed (drives correct P&L and SL/TP), falling back
  // to intended values only when the fill can't be confirmed.
  let entryPrice = price
  let filledQty = quantity
  let fillConfirmed = true

  // Native (exchange-side) stop-loss backstop tracking — set only in live mode
  // when the exchange accepts the reduce-only stop. The engine's soft stop in
  // evaluateExit still drives all normal exits; this is defense-in-depth so the
  // stop still fires if the bot process is down or a tick is delayed.
  let stopOrderId: string | null = null
  let nativeStopPlaced = false

  if (cfg.mode === "live") {
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    let fill
    try {
      fill = await exchange.placeMarketOrderConfirmed({
        symbol: cfg.symbol,
        side: direction === "long" ? 1 : 3,
        volume: quantity,
        leverage: cfg.leverage,
      })
    } catch (err) {
      await log("error", `LIVE order failed: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
    if (fill.confirmed && fill.avgPrice > 0) {
      entryPrice = fill.avgPrice
      // Conservative quantity handling: exchanges report fill volume in
      // venue-native units (contracts vs coins, contract multipliers) which we
      // cannot verify offline. Only adopt the reported volume when it is within
      // a sane ratio of what we intended; otherwise keep the intended qty and
      // warn, so a unit mismatch can't silently corrupt position sizing.
      const ratio = quantity > 0 ? fill.filledVolume / quantity : 0
      if (fill.filledVolume > 0 && ratio >= 0.5 && ratio <= 1.5) {
        filledQty = fill.filledVolume
      } else if (fill.filledVolume > 0) {
        await log(
          "info",
          `Fill volume ${fill.filledVolume} differs from intended ${quantity.toFixed(6)} beyond safe ratio; keeping intended qty for accounting`,
        )
      }
    } else {
      fillConfirmed = false
      await log(
        "error",
        `LIVE entry fill unconfirmed (order ${fill.orderId || "unknown"}); recording intended price ${price} — P&L/SL/TP for this position may be inaccurate`,
      )
    }

    // Place the native reduce-only stop-loss as a best-effort backstop, sized to
    // the ACTUAL filled quantity. A failure here must NEVER abort the position —
    // the entry already filled and the soft stop remains active — so we log and
    // continue.
    if (stopLoss != null) {
      try {
        const r = await exchange.placeStopLoss({
          symbol: cfg.symbol,
          positionSide: direction,
          stopPrice: stopLoss,
          volume: filledQty,
          leverage: cfg.leverage,
        })
        nativeStopPlaced = r.placed
        stopOrderId = r.orderId || null
        await log(
          "info",
          `Native stop-loss placed @ ${stopLoss.toFixed(2)} for ${direction.toUpperCase()} ${cfg.symbol}${stopOrderId ? ` (id ${stopOrderId})` : ""}`,
        )
      } catch (err) {
        await log(
          "error",
          `Native stop-loss placement FAILED for ${direction.toUpperCase()} ${cfg.symbol}; soft stop remains active: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // Fee on the actual executed notional (falls back to intended when unconfirmed).
  const openFee = filledQty * entryPrice * TAKER_FEE

  await db.insert(positions).values({
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    side: direction,
    entryPrice,
    sizeUsdt,
    quantity: filledQty,
    leverage: cfg.leverage,
    stopLoss,
    takeProfit,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    entryConfidence: confidence,
    entryFeatures: features as unknown as Record<string, number>,
    atrAtEntry: snap.atr,
    strategy,
    rangeTarget,
    fillConfirmed,
    stopOrderId,
    nativeStopPlaced,
  })

  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} - ${openFee}` })
    .where(eq(botConfig.id, 1))

  await log(
    "trade",
    `Opened ${direction.toUpperCase()} [${strategy}] @ ${entryPrice.toFixed(2)}${fillConfirmed ? "" : " (unconfirmed)"} | size ${sizeUsdt.toFixed(2)} USDT x${cfg.leverage} | SL ${stopLoss != null ? stopLoss.toFixed(2) : "none"} TP ${takeProfit != null ? takeProfit.toFixed(2) : "none"} | confidence ${(confidence * 100).toFixed(1)}%`,
  )

  return sizeUsdt
}

export async function takePartialProfit(
  position: Position,
  exitPrice: number,
  fraction: number,
  cfg: BotConfig,
): Promise<void> {
  const remainingQty = position.remainingQuantity ?? position.quantity
  const closeQty = remainingQty * fraction

  // Effective exit price. In paper mode it stays at the intended price; in live
  // mode we confirm the actual close fill so realized P&L reflects reality.
  let effExitPrice = exitPrice
  let fillConfirmed = true

  if (cfg.mode === "live") {
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    let fill
    try {
      fill = await exchange.placeMarketOrderConfirmed({
        symbol: position.symbol,
        side: position.side === "long" ? 4 : 2,
        volume: closeQty,
        leverage: position.leverage,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await log("error", `LIVE partial close failed: ${errMsg}`)
      return
    }
    if (fill.confirmed && fill.avgPrice > 0) {
      effExitPrice = fill.avgPrice
    } else {
      fillConfirmed = false
      await log(
        "error",
        `LIVE partial-close fill unconfirmed (order ${fill.orderId || "unknown"}); recording intended exit ${exitPrice} — realized P&L may be inaccurate`,
      )
    }
  }

  const dir = position.side === "long" ? 1 : -1
  const grossPnl = (effExitPrice - position.entryPrice) * dir * closeQty
  const closeFee = position.sizeUsdt * position.leverage * TAKER_FEE * fraction
  const netPnl = grossPnl - closeFee

  await db.insert(trades).values({
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: effExitPrice,
    sizeUsdt: position.sizeUsdt * fraction,
    leverage: position.leverage,
    pnl: netPnl,
    fees: closeFee,
    exitReason: "partial",
    strategy: position.strategy ?? "trend",
    entryConfidence: position.entryConfidence,
    openedAt: position.openedAt,
    partial: true,
    live: cfg.mode === "live",
    fillConfirmed,
  })

  // The soft stop is tightened to break-even here. The native (exchange-side)
  // stop backstop is intentionally NOT re-placed — it stays at the initial SL
  // as a disaster floor. Its reduce-only order already covers only the (now
  // smaller) live position, so it can never over-close; the soft stop drives
  // the tighter break-even exit.
  await db
    .update(positions)
    .set({
      remainingQuantity: remainingQty - closeQty,
      partialExitCount: sql`${positions.partialExitCount} + 1`,
      stopLoss: position.entryPrice,
      breakEvenMoved: true,
    })
    .where(eq(positions.id, position.id))

  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` })
    .where(eq(botConfig.id, 1))

  await log(
    "trade",
    `Partial close ${position.side.toUpperCase()} @ ${effExitPrice.toFixed(2)}${fillConfirmed ? "" : " (unconfirmed)"} | ${(fraction * 100).toFixed(0)}% of position | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT | SL → break-even`,
  )
}

export async function closePosition(
  position: Position,
  exitPrice: number,
  reason: "tp" | "sl" | "trail" | "signal" | "manual" | "partial",
  cfg: BotConfig,
): Promise<void> {
  // Effective exit price. In paper mode it stays at the intended price; in live
  // mode we confirm the actual close fill so realized P&L reflects reality.
  let effExitPrice = exitPrice
  let fillConfirmed = true

  if (cfg.mode === "live") {
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    let fill
    try {
      fill = await exchange.placeMarketOrderConfirmed({
        symbol: position.symbol,
        side: position.side === "long" ? 4 : 2,
        volume: position.remainingQuantity ?? position.quantity,
        leverage: position.leverage,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // RECONCILE: MEXC 2009 means the position is already gone (closed
      // manually, liquidated, or never existed). Treat it as already-closed
      // instead of retrying forever — mark it closed in the DB so the engine
      // stops trying to close a phantom position. No trade is recorded and no
      // ML training happens, since we don't know the real exit price.
      if (errMsg.includes("2009") || errMsg.includes("nonexistent")) {
        await db.update(positions).set({ status: "closed", closedAt: sql`NOW()` }).where(eq(positions.id, position.id))
        await log("info", `Position ${position.symbol} ${position.side} already closed on exchange (2009) — reconciled DB state`)
        return
      }
      await log("error", `LIVE close failed: ${errMsg}`)
      return
    }
    if (fill.confirmed && fill.avgPrice > 0) {
      effExitPrice = fill.avgPrice
    } else {
      fillConfirmed = false
      await log(
        "error",
        `LIVE close fill unconfirmed (order ${fill.orderId || "unknown"}); recording intended exit ${exitPrice} — realized P&L may be inaccurate`,
      )
    }

    // Cancel the native stop-loss backstop now that the position is closed.
    // Best-effort: Bybit auto-cancels its position-attached stop on close, and
    // a lingering reduce-only trigger on MEXC/Gate is harmless (it can only
    // reduce a now-zero position), so a failure here is logged, never fatal.
    if (position.nativeStopPlaced) {
      try {
        await exchange.cancelStopLoss({
          symbol: position.symbol,
          positionSide: position.side as "long" | "short",
          orderId: position.stopOrderId ?? "",
        })
      } catch (err) {
        await log(
          "error",
          `Native stop-loss cancel failed for ${position.symbol} (harmless if already gone): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  const grossPnl = unrealizedPnl(position, effExitPrice)
  const remainingQty = position.remainingQuantity ?? position.quantity
  const remainingSize = position.sizeUsdt * (remainingQty / position.quantity)
  const closeFee = remainingSize * position.leverage * TAKER_FEE
  const netPnl = grossPnl - closeFee
  const pnlPct = (netPnl / remainingSize) * 100

  const [trade] = await db
    .insert(trades)
    .values({
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: effExitPrice,
      sizeUsdt: remainingSize,
      leverage: position.leverage,
      pnl: netPnl,
      fees: closeFee,
      exitReason: reason,
      strategy: position.strategy ?? "trend",
      entryConfidence: position.entryConfidence,
      openedAt: position.openedAt,
      live: cfg.mode === "live",
      fillConfirmed,
    })
    .returning()

  await db
    .update(positions)
    .set({ status: "closed", closedAt: sql`NOW()` })
    .where(eq(positions.id, position.id))

  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` })
    .where(eq(botConfig.id, 1))

  await log(
    "trade",
    `Closed ${position.side.toUpperCase()} @ ${effExitPrice.toFixed(2)}${fillConfirmed ? "" : " (unconfirmed)"} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%) | reason: ${reason.toUpperCase()}`,
  )

  // Learning loop: every closed trade trains the model dedicated to its strategy
  // (scalp → scalp model, everything else on this engine path → trend model), so
  // trend and scalp each learn their own edge instead of poisoning a shared model.
  if (position.entryFeatures) {
    try {
      const learnStrategy = position.strategy === "scalp" ? "scalp" : "trend"
      const modelId = learnStrategy === "scalp" ? MODEL_IDS.scalp : MODEL_IDS.trend
      const model = await loadModelFor(learnStrategy)
      await trainOnTrade(
        model,
        position.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        pnlPct,
        cfg.mlLearningRate,
        trade.id,
        position.id,
        modelId,
      )
      await log("info", `Model[${learnStrategy}] updated from trade #${trade.id} (${netPnl > 0 ? "win" : "loss"})`)
    } catch (err) {
      await log("error", `Model training failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// Webhook-triggered execution: external signals (e.g. TradingView alerts)
// bypass the cron wait and the EMA-crossover requirement, but entries still
// pass through the ML confidence gate so the learning loop stays consistent.
export async function runWebhookSignal(
  action: "tick" | "long" | "short" | "close",
): Promise<{ status: string; detail?: string }> {
  if (action === "tick") {
    await log("info", "Webhook: immediate tick triggered")
    return runTick()
  }

  const cfg = await getConfig()
  if (cfg.status !== "running") {
    return { status: "skipped", detail: "Bot is stopped" }
  }

  try {
    const tickerCache = new Map()
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    const [candles, ticker] = await Promise.all([
      exchange.fetchKlines(toExchangeSymbol(cfg.symbol), cfg.timeframe, cfg.lorentzianWebhooks ? Math.max(200, cfg.lorentzianLookback + 40) : 200),
      fetchTickerWithRetry(exchange, cfg.symbol, tickerCache),
    ])
    if (candles.length < 60) {
      await log("error", `Webhook: insufficient candle data: ${candles.length}`)
      return { status: "error", detail: "Insufficient candles" }
    }

    const snap = computeSnapshot(candles, cfg)
    snap.price = ticker.lastPrice
    const openPos = await getOpenPosition(cfg.symbol, cfg.timeframe)

    if (action === "close") {
      if (!openPos) return { status: "skipped", detail: "No open position" }
      await closePosition(openPos, snap.price, "signal", cfg)
      return { status: "ok", detail: "Position closed via webhook" }
    }

    // action is "long" | "short"
    if ((action === "long" && !cfg.allowLong) || (action === "short" && !cfg.allowShort)) {
      return { status: "skipped", detail: `${action} entries disabled in settings` }
    }

    if (openPos) {
      if (openPos.side === action) {
        return { status: "skipped", detail: `Already in a ${action} position` }
      }
      // Opposite webhook signal: close current position first
      await closePosition(openPos, snap.price, "signal", cfg)
    }

    // Webhook signals are discretionary trend entries → use the trend model.
    const model = await loadModelFor("trend")
    const features: FeatureVector = {
      ...snap.features,
      sideLong: action === "long" ? 1 : -1,
    }
    const { allowed: logisticAllowed, confidence } = gateEntry(model, features, cfg.mlConfidenceThreshold)
    let allowed = logisticAllowed
    let confirmationReason = `ML confidence ${(confidence * 100).toFixed(1)}%`
    if (cfg.lorentzianWebhooks) {
      const lorentzian = classifyLorentzian(candles, lorentzianOptions(cfg))
      const confirmation = combineConfirmation(cfg.confirmationMode, action, logisticAllowed, lorentzian)
      allowed = confirmation.allowed
      confirmationReason = `${confirmation.reason}; ${lorentzian.reason}`
    }

    if (!allowed) {
      await log("info", `Webhook ${action.toUpperCase()} signal rejected: ${confirmationReason}`)
      return { status: "rejected", detail: confirmationReason }
    }

    await log("info", `Webhook ${action.toUpperCase()} signal accepted: ${confirmationReason}`)
    // Refresh the portfolio risk state before opening. Unlike runTick(), the
    // webhook entry path does not otherwise recompute it, so openPosition()'s
    // risk gate would run against a stale (or, after a cold start, null and now
    // fail-closed) state. Compute it fresh here for long/short entries.
    await evaluatePortfolioRisk(cfg)
    await openPosition(cfg, action, snap, confidence, features, "webhook")
    return { status: "ok", detail: `${action} opened via webhook` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await log("error", `Webhook signal failed: ${message}`)
    return { status: "error", detail: message }
  }
}

async function fetchTickerWithRetry(exchange: any, symbol: string, cache: Map<string, any>) {
  if (cache.has(symbol)) return cache.get(symbol)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await exchange.fetchTicker(toExchangeSymbol(symbol))
      cache.set(symbol, result)
      return result
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw new Error("Ticker fetch failed after 3 retries")
}

// Ticker cache to avoid rate limits
export async function runTick(): Promise<{ status: string; detail?: string }> {
  if (_tickInProgress) {
    console.log("TICK SKIPPED: tick already in progress")
    return { status: "skipped", detail: "Tick already in progress" }
  }
  _tickInProgress = true
  // Cross-process mutual exclusion. `_tickInProgress` only guards re-entrance
  // within a SINGLE process; when more than one instance/machine runs the
  // engine (e.g. multiple Fly machines, or an overlapping cron + webhook tick),
  // two ticks could still make trade decisions concurrently and double-open.
  // A Postgres session-level advisory lock serializes ticks across ALL
  // processes sharing the database. We hold it on a dedicated client for the
  // whole tick and release it in `finally`.
  let lockClient: import("pg").PoolClient | null = null
  let lockAcquired = false
  // The whole body runs inside try/finally so the reentrance lock is ALWAYS
  // released — on normal return, on any early return (bot stopped, kill switch),
  // and on any thrown exception. Previously the flag was cleared only on the
  // happy path, so a single early return or error left it stuck `true` forever,
  // making every subsequent tick bail out as "busy" and silently freezing the bot.
  try {
    // Acquire the cross-process advisory lock before any trade decisions.
    // pg_try_advisory_lock is non-blocking: if another process holds it we
    // skip this tick rather than queue up behind it.
    try {
      lockClient = await pool.connect()
      const res = await lockClient.query(
        "SELECT pg_try_advisory_lock(hashtext('engine:runTick')) AS locked",
      )
      lockAcquired = res.rows[0]?.locked === true
    } catch (err) {
      if (lockClient) {
        lockClient.release()
        lockClient = null
      }
      await log("error", `Tick advisory-lock acquire failed: ${err instanceof Error ? err.message : String(err)}`)
      return { status: "error", detail: "Advisory lock acquire failed" }
    }
    if (!lockAcquired) {
      console.log("TICK SKIPPED: advisory lock held by another process")
      return { status: "skipped", detail: "Tick already running on another process" }
    }

    const cfg = await getConfig()
    await reconcilePositions(cfg)
    console.log("TICK: bot running"); if (cfg.status !== "running") return { status: "skipped", detail: "Bot is stopped" }

    // ── Equity kill switch (paper mode) ──────────────────────────────────────
    // Runs before any grid / strategy logic so no new orders are placed once
    // the threshold is breached.  When paper_balance has dropped ≥3% below
    // paper_starting_balance the grid is disabled and the tick aborts.
    // To resume: manually set grid_enabled=true in bot_config after reviewing.
    if (cfg.mode === "paper") {
      const _ksStart   = Number(cfg.paperStartingBalance ?? 10000)
      const _ksCurrent = Number(cfg.paperBalance ?? _ksStart)
      const _ksDD      = (_ksStart - _ksCurrent) / _ksStart
      if (_ksDD >= 0.03) {
        await log(
          "error",
          `🛑 EQUITY KILL SWITCH TRIGGERED — paper balance $${_ksCurrent.toFixed(2)} ` +
          `is ${(_ksDD * 100).toFixed(2)}% below starting $${_ksStart.toFixed(2)}. ` +
          `Grid disabled. Manual review required before re-enabling.`,
        )
        await db.update(botConfig).set({ gridEnabled: false }).where(eq(botConfig.id, cfg.id))
        return { status: "halted", detail: `Equity kill switch: ${(_ksDD * 100).toFixed(2)}% drawdown` }
      }
    }

    const [openPositions, activeGrid] = await Promise.all([
      getOpenPositions(),
      db.select().from(gridOrders).where(eq(gridOrders.status, "pending")),
    ])
    const marketKeys = new Set<string>([`${cfg.symbol}|${cfg.timeframe}`])
    for (const pos of openPositions) marketKeys.add(`${pos.symbol}|${pos.timeframe}`)
    for (const order of activeGrid) marketKeys.add(`${order.symbol}|${order.timeframe}`)

    // ── Portfolio risk assessment (before any new capital is deployed) ──
    // Uses realized PnL + last-known unrealized; refreshed at tick end. When
    // halted, openPosition() and setupGrid() will refuse to open NEW risk, but
    // exits / stop-losses / teardowns below still run normally.
    const risk = await evaluatePortfolioRisk(cfg)
    if (risk.tradingHalted) {
      // Only log when halt state changes (dedup spam)
      const currentHaltState = risk.reasons.join("|")
      if (currentHaltState !== _lastRiskHaltState) {
        await log(
          "info",
          `⚠️ Risk layer HALTED new trades — ${risk.reasons.join("; ")} | equity ${risk.equity.toFixed(2)} day ${risk.dailyPnlPct >= 0 ? "+" : ""}${(risk.dailyPnlPct * 100).toFixed(1)}% dd ${(risk.drawdownPct * 100).toFixed(1)}%`,
        )
        _lastRiskHaltState = currentHaltState
      }
    } else {
      // Reset when trading resumes
      _lastRiskHaltState = null
    }

    // Separate models per entry style so each learns its own edge (see MODEL_IDS):
    // the automated trend/momentum entry uses the trend model, the pullback
    // scalper uses the scalp model. Grid trains its own model inside grid.ts.
    const trendModel = await loadModelFor("trend")
    const scalpModel = await loadModelFor("scalp")
    const marks = new Map<string, number>()

    const tickerCache = new Map()
    const exchange = getExchangeClient(cfg.exchange as Exchange)

    // ── Multi-pair grid execution ──
    const gridCfgs = await getGridConfigs()

    for (const gc of gridCfgs) {
      try {
        const [candles, ticker] = await Promise.all([
          exchange.fetchKlines(toExchangeSymbol(gc.symbol), gc.timeframe, 200),
          tickerCache.get(gc.symbol) || fetchTickerWithRetry(exchange, gc.symbol, tickerCache),
        ])
        if (candles.length < 60) { await log("error", `Grid ${gc.symbol}: insufficient candles`); continue }
        const gridCfg = { ...cfg, symbol: gc.symbol, timeframe: gc.timeframe } as BotConfig;
        const snap = computeSnapshot(candles, gridCfg);
        snap.price = ticker.lastPrice
        marks.set(gc.symbol, snap.price)
        const regimeConfig = { ...cfg, symbol: gc.symbol, timeframe: gc.timeframe } as BotConfig;
        await runGridTick(cfg, gc, snap, detectRegime(snap, regimeConfig), exchange)
      } catch (err) {
        await log("error", `Grid ${gc.symbol} tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── Flash Fade detection ──
    for (const gc of gridCfgs) {
      try {
        const ffCandles = await exchange.fetchKlines(toExchangeSymbol(gc.symbol), "Min5", 50)
        if (ffCandles.length >= 30) {
          const ffSignal = detectFlashFade(ffCandles)
          if (ffSignal.detected) {
            await executeFlashFade(gc.symbol, gc.timeframe, ffSignal, {
              enabled: true, minMovePct: 20, minVolumeMultiplier: 5,
              positionSizeUsdt: 300, leverage: 3, maxPositions: 2,
            })
          }
        }
      } catch (err) { /* best-effort */ }
    }

    for (const key of marketKeys) {
      const [symbol, timeframe] = key.split("|")
      const marketCfg: BotConfig = { ...cfg, symbol, timeframe } as BotConfig;
      try {
        const isSelected = symbol === cfg.symbol && timeframe === cfg.timeframe
        const candleLimit = isSelected ? Math.max(200, cfg.lorentzianLookback + 40) : 200
        const [candles, ticker] = await Promise.all([
          exchange.fetchKlines(toExchangeSymbol(symbol), timeframe, candleLimit),
          fetchTickerWithRetry(exchange, symbol, tickerCache),
        ])
        if (candles.length < 60) {
          await log("error", `${symbol} ${timeframe}: insufficient candle data (${candles.length})`)
          continue
        }

        const snap = computeSnapshot(candles, marketCfg)
        snap.price = ticker.lastPrice
        marks.set(symbol, snap.price)

        const marketPosition = openPositions.find((p) => p.symbol === symbol && p.timeframe === timeframe)
        if (marketPosition) {
          const opposite =
            (marketPosition.strategy === "trend" || marketPosition.strategy === "scalp") &&
            isOppositeSignal(snap, marketPosition.side as "long" | "short")
          const decision = evaluateExit(marketPosition, snap, marketCfg, opposite)
          if (decision.action === "close") {
            await closePosition(marketPosition, snap.price, decision.reason!, marketCfg)
          } else if (decision.action === "partial") {
            await takePartialProfit(marketPosition, snap.price, decision.partialFraction ?? 0.5, marketCfg)
          } else if (Object.keys(decision.updates).length > 0) {
            await db.update(positions).set(decision.updates).where(eq(positions.id, marketPosition.id))
          }
        }

        if (isSelected) await resolveClassifierOutcomes(symbol, timeframe, candles)
        if (isSelected && !marketPosition) {
          // ── Trend-scalper path (priority) ──
          // Higher-quality pullback-in-trend entries with risk-based sizing and
          // ATR R-multiple targets. Still gated by ML + Lorentzian + risk layer.
          let scalpHandled = false
          if (process.env.SCALPER_ENABLED !== "0") {
            const scalp = evaluateScalpSignal(snap, candles, marketCfg, cfg.paperBalance ?? 10000)
            if (scalp.triggered && scalp.direction) {
              const scalpFeatures: FeatureVector = {
                ...snap.features,
                sideLong: scalp.direction === "long" ? 1 : -1,
              }
              const { allowed: mlAllowed, confidence: mlConf } = gateEntry(
                scalpModel,
                scalpFeatures,
                marketCfg.mlConfidenceThreshold,
              )
              const lorentzian = classifyLorentzian(candles, lorentzianOptions(marketCfg))
              const confirmation = combineConfirmation(
                marketCfg.confirmationMode,
                scalp.direction,
                mlAllowed,
                lorentzian,
              )
              // Blend the scalp confluence with the ML confidence so sizing and
              // the learning signal reflect BOTH the setup quality and the model.
              const blended = Math.max(0, Math.min(1, scalp.confidence * (mlConf || 0.5) * 2))
              const reason = `SCALP: ${scalp.reason}; ${confirmation.reason}; ${lorentzian.reason}`

              // ── One organism: build the shared state and let decide() choose ──
              const rs = getRiskState()
              const gridInv = await computeGridInventory(symbol, timeframe, snap.price)
              const awareness = buildAwareness(
                symbol,
                timeframe,
                snap,
                marketCfg,
                scalp,
                gridInv,
                {
                  exposurePct: rs?.usedMarginPct ?? 0,
                  marginRemaining: rs?.marginBudgetRemaining ?? 0,
                  killSwitch: rs?.killSwitch ?? false,
                },
                { logistic: mlConf, lorentzian: lorentzian.confidence, allowed: confirmation.allowed },
              )
              const decision = decide(awareness)

              await db.insert(classifierDecisions).values({
                symbol,
                timeframe,
                candleTime: candles[candles.length - 1].time,
                candidateDirection: scalp.direction,
                strategy: "scalp",
                regime: detectRegime(snap, marketCfg),
                entryPrice: snap.price,
                confirmationMode: marketCfg.confirmationMode,
                logisticAllowed: mlAllowed,
                logisticConfidence: mlConf,
                lorentzianDirection: lorentzian.direction,
                lorentzianVote: lorentzian.vote,
                lorentzianConfidence: lorentzian.confidence,
                lorentzianAllowed: lorentzian.allowed,
                lorentzianFilters: lorentzian.filters,
                finalAllowed: decision.action === "scalp-trend",
                reason,
              }).onConflictDoNothing()
              if (decision.action === "scalp-trend") {
                await log("info", `SCALP ${decision.direction.toUpperCase()} candidate: ${reason}`, {
                  scalpConfluence: scalp.confidence,
                  mlConfidence: mlConf,
                  lorentzianConfidence: lorentzian.confidence,
                  rMultiple: scalp.rMultiple,
                })
                await openPosition(marketCfg, decision.direction, snap, blended, scalpFeatures, "scalp", {
                  sizeUsdtOverride: scalp.suggestedSizeUsdt ?? undefined,
                  stopLoss: scalp.stopLoss ?? undefined,
                  takeProfit: scalp.takeProfit ?? undefined,
                })
                scalpHandled = true
              } else if (decision.action === "trail-inventory") {
                // Single ATR trailing stop on the aligned inventory. A trail only
                // ever moves TIGHTER (in our favor) — it never widens a stop.
                const trailStop = decision.direction === "long"
                  ? snap.price - marketCfg.trailAtrMult * snap.atr
                  : snap.price + marketCfg.trailAtrMult * snap.atr
                const active = await getActiveOrders(symbol, timeframe)
                let trailed = 0
                for (const o of active) {
                  if (o.buyPrice == null) continue
                  const isLong = o.side === "sell"
                  if (isLong !== (decision.direction === "long")) continue
                  const newSl = decision.direction === "long"
                    ? Math.max(o.slPrice ?? -Infinity, trailStop)
                    : Math.min(o.slPrice ?? Infinity, trailStop)
                  if (o.slPrice == null || newSl !== o.slPrice) {
                    await db.update(gridOrders).set({ slPrice: newSl }).where(eq(gridOrders.id, o.id))
                    trailed++
                  }
                }
                await log("info", `TRAIL-INVENTORY ${decision.direction}: trailing stop → ${trailStop.toFixed(6)} (${trailed} rung(s) tightened)`)
              }
            }
          }

          if (!scalpHandled) {
          const signal = evaluateEntry(snap, candles, marketCfg, trendModel, cfg.paperBalance ?? 10000)
          if (signal.baseTriggered && signal.candidateDirection && signal.features) {
            const lorentzian = classifyLorentzian(candles, lorentzianOptions(marketCfg))
            const confirmation = combineConfirmation(
              marketCfg.confirmationMode,
              signal.candidateDirection,
              signal.mlAllowed,
              lorentzian,
            )
            const reason = `${confirmation.reason}; ${lorentzian.reason}`
            await db.insert(classifierDecisions).values({
              symbol,
              timeframe,
              candleTime: candles[candles.length - 1].time,
              candidateDirection: signal.candidateDirection,
              strategy: signal.strategy,
              regime: signal.regime,
              entryPrice: snap.price,
              confirmationMode: marketCfg.confirmationMode,
              logisticAllowed: signal.mlAllowed,
              logisticConfidence: signal.confidence,
              lorentzianDirection: lorentzian.direction,
              lorentzianVote: lorentzian.vote,
              lorentzianConfidence: lorentzian.confidence,
              lorentzianAllowed: lorentzian.allowed,
              lorentzianFilters: lorentzian.filters,
              finalAllowed: confirmation.allowed,
              reason,
            }).onConflictDoNothing()
            if (confirmation.allowed) {
              await log("info", `${signal.candidateDirection.toUpperCase()} [${signal.strategy}] candidate: ${reason}`, {
                logisticConfidence: signal.confidence,
                lorentzianConfidence: lorentzian.confidence,
                lorentzianVote: lorentzian.vote,
                confirmationMode: marketCfg.confirmationMode,
              })
              const advCfg = advancedConfigFromBot(marketCfg)
              const candlesByTf: Record<string, Candle[]> = { [timeframe]: candles }
              if (advCfg.mtfEnabled && advCfg.htfTimeframe && advCfg.htfTimeframe !== timeframe) {
                const htfCandles = await exchange
                  .fetchKlines(toExchangeSymbol(symbol), advCfg.htfTimeframe, 200)
                  .catch(() => null)
                if (htfCandles && htfCandles.length >= 60) {
                  candlesByTf[advCfg.htfTimeframe] = htfCandles
                }
              }
              let takerBuyVolume: number | undefined
              let takerSellVolume: number | undefined
              let cvd: number | undefined
              let cvdMean: number | undefined
              let cvdStd: number | undefined
              if (advCfg.smartMoneyEnabled && cfg.exchange !== "bybit") {
                try {
                  const deals = await fetchDeals(toExchangeSymbol(symbol))
                  const flow = computeTakerFlow(deals)
                  const cvdStats = cvdRollingStats(flow.cvd)
                  takerBuyVolume = flow.takerBuyVolume
                  takerSellVolume = flow.takerSellVolume
                  cvd = cvdStats.cvd
                  cvdMean = cvdStats.cvdMean
                  cvdStd = cvdStats.cvdStd
                } catch (err) {
                  await log("warn", `${symbol}: deals fetch failed, smart-money flow skipped: ${err}`)
                }
              }
              const adv = evaluateAdvancedEntry(
                signal.candidateDirection,
                signal.confidence,
                signal.strategy,
                candlesByTf,
                {
                  fundingRate: typeof ticker.fundingRate === "number" ? ticker.fundingRate : undefined,
                  takerBuyVolume,
                  takerSellVolume,
                  cvd,
                  cvdMean,
                  cvdStd,
                },
                cfg.paperBalance ?? 10000,
                snap.atr,
                snap.price,
                advCfg,
              )
              if (adv.passed) {
                await openPosition(
                  marketCfg,
                  adv.direction ?? signal.candidateDirection,
                  snap,
                  adv.confidence,
                  signal.features,
                  signal.strategy,
                  adv.sizeUsdt != null ? { sizeUsdtOverride: adv.sizeUsdt } : undefined,
                )
              } else {
                await log("info", `Advanced strategy blocked ${signal.candidateDirection}: ${adv.reason}`)
              }
            }
          }
          }
        }

        // GRID-FIX: Grid symbols already processed in loop above with proper GridConfig
      } catch (err) {
        await log("error", `${symbol} ${timeframe} tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const cfgAfter = await getConfig()
    const positionsAfter = await getOpenPositions()
    let totalUnrealized = 0
    for (const position of positionsAfter) {
      const mark = marks.get(position.symbol)
      if (mark != null) totalUnrealized += unrealizedPnl(position, mark)
    }
    for (const key of marketKeys) {
      const [symbol, timeframe] = key.split("|")
      const mark = marks.get(symbol)
      if (mark != null) totalUnrealized += await gridUnrealizedPnl(mark, symbol, timeframe)
    }

    // DISABLED: auto grid advisor. This was auto-building + enabling new grids
    // on every tick (runGridAiAdvisor(true) with autoApply), which kept adding
    // coins and over-budgeting. Manual AI Advisor (the UI button) still works.
    // Re-enable by uncommenting the call below.
    // try {
    //   await maybeRunGridAiAdvisorAuto()
    // } catch (err) { /* best-effort */ }

    // ── AI Advisor: run analysis on schedule ──
    if (cfg.aiAdvisorEnabled && cfg.aiAnalysisSchedule !== "manual") {
      const now = new Date()
      const lastAnalysis = cfg.aiLastAnalysis ? new Date(cfg.aiLastAnalysis) : null
      let shouldRun = false

      if (!lastAnalysis) {
        shouldRun = true
      } else if (cfg.aiAnalysisSchedule === "daily") {
        shouldRun = now.getTime() - lastAnalysis.getTime() > 24 * 60 * 60 * 1000
      } else if (cfg.aiAnalysisSchedule === "weekly") {
        shouldRun = now.getTime() - lastAnalysis.getTime() > 7 * 24 * 60 * 60 * 1000
      }

      if (shouldRun) {
        try {
          const result = await analyzeTradesForMarket(cfg.symbol, cfg.timeframe)
          if (result?.recommendations.length) {
            await log("info", `AI Advisor: ${result.recommendations.length} recommendations for ${cfg.symbol}`)
            // Auto-apply if confidence is high
            const highConfidence = result.recommendations.filter(r =>
              typeof r.suggested === 'number' && typeof r.current === 'number' &&
              Math.abs(r.suggested - r.current) / Math.abs(r.current) < 0.5
            )
            if (highConfidence.length > 0) {
              await applyRecommendations(0, highConfidence)
              await log("info", `AI Advisor: auto-applied ${highConfidence.length} conservative recommendations`)
            }
          }
          await db.update(botConfig).set({ aiLastAnalysis: now }).where(eq(botConfig.id, 1))
        } catch (err) {
          // AI advisor is best-effort, don't block trading
        }
      }
    }

    // Record equity snapshot
    const isLive = cfgAfter.mode === "live"
    let recordBalance = cfgAfter.paperBalance
    let recordEquity = cfgAfter.paperBalance + totalUnrealized
    let recordUnrealized = totalUnrealized
    
    if (isLive) {
      // In live mode, fetch actual account equity from MEXC
      try {
        const assets = await getExchangeClient(cfgAfter.exchange as Exchange).getAccountAssets()
        const usdt = assets.find((a) => a.currency === "USDT") ?? null
        if (usdt) {
          recordBalance = usdt.availableBalance || 0
          recordEquity = usdt.equity || 0
          recordUnrealized = usdt.unrealized || 0
        }
      } catch (err) {
        // If live fetch fails, fall back to paper values
        console.error("Live equity fetch failed, using paper values:", err)
      }
    }
    
    await db.insert(equitySnapshots).values({
      balance: recordBalance,
      equity: recordEquity,
      unrealizedPnl: recordUnrealized,
      live: isLive,
    })

    // Refresh cached risk state with the exact freshly-computed unrealized PnL,
    // so the /api/bot/state route and the next tick see up-to-date numbers.
    try {
      await evaluatePortfolioRisk(cfgAfter, totalUnrealized)
    } catch { /* best-effort */ }

    return { status: "ok" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await log("error", `Tick failed: ${message}`)
    return { status: "error", detail: message }
  } finally {
    // Release the cross-process advisory lock (only if we acquired it) and
    // return its dedicated client to the pool, then clear the in-process flag.
    if (lockClient) {
      try {
        if (lockAcquired) {
          await lockClient.query("SELECT pg_advisory_unlock(hashtext('engine:runTick'))")
        }
      } catch (err) {
        await log("error", `Tick advisory-unlock failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        lockClient.release()
      }
    }
    _tickInProgress = false
  }
}

// --- Real-time WebSocket Engine ---
export async function initRealtimeEngine(symbol: string, timeframe: string) {
  if (!(globalThis as any).__wsManagers) (globalThis as any).__wsManagers = {}
  // If a WS already exists for this symbol, don't create a duplicate
  if ((globalThis as any).__wsManagers[symbol]) return
  
  console.log(`[Engine] Using REST polling for ${symbol} (no MEXC websocket)`)
  // REST polling fallback - fetch price every 15 seconds
  const cfg = await getConfig()
  const pollInterval = setInterval(async () => {
    try {
      const exchange = getExchangeClient(cfg.exchange as Exchange)
      const ticker = await exchange.fetchTicker(symbol)
      if (ticker?.lastPrice) {
        livePrices[symbol] = ticker.lastPrice
      }
    } catch (err) { /* best-effort */ }
  }, 15000)
  const manager = { disconnect: () => clearInterval(pollInterval) }

  console.log(`[Engine] Polling started for ${symbol}`)
  
  // Store the manager
  ;(globalThis as any).__wsManagers[symbol] = manager
  console.log(`[Engine] Manager stored for ${symbol}`)
}

export async function stopRealtimeEngine(symbol: string) {
  if ((globalThis as any).__wsManagers?.[symbol]) {
    await (globalThis as any).__wsManagers[symbol].disconnect()
    delete (globalThis as any).__wsManagers[symbol]
    console.log(`[Engine] Stopped realtime engine for ${symbol}`)
  }
}

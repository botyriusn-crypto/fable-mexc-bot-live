// Tick orchestration: data → features → ML-gated signal → exit management →
// paper/live execution → model update → persistence.

import { db } from "./db"
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
import { and, eq, isNull, sql } from "drizzle-orm"
import { type Candle, fetchDeals, computeTakerFlow } from "./mexc/public"
import { getExchangeClient, type Exchange } from "./exchange"
import { classifyLorentzian, combineConfirmation } from "./lorentzian"
import { computeSnapshot, type FeatureVector, type IndicatorSnapshot } from "./indicators"
import { loadModelFor, trainOnTrade, gateEntry, MODEL_IDS } from "./ml"
import { evaluateEntry, isOppositeSignal, detectRegime } from "./strategy"
import { runGridTick, gridUnrealizedPnl, getGridConfigs, type GridConfig } from "./grid"
import { detectFlashFade, executeFlashFade } from "./flash-fade"
import { maybeRunGridAiAdvisorAuto } from "./ai-grid-advisor"
import { runSniperCycle } from "./sniper"
import { analyzeTradesForMarket, applyRecommendations } from "./ai-advisor"
import { computeInitialStops, evaluateExit } from "./exits"
import { MexcWebSocketManager } from './mexc/ws';
import { getAccountAssets, getOpenPositions as getMexcOpenPositions } from './mexc/private';
import {
  evaluatePortfolioRisk,
  isTradingHalted,
  canOpenNewPosition,
  marginBudgetRemaining,
  getRiskState,
} from "./risk-manager"
import { evaluateScalpSignal } from "./trend-scalper"
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
    useAdxFilter: cfg.lorentzianUseAdxFilter,
    regimeThreshold: cfg.lorentzianRegimeThreshold,
    adxThreshold: cfg.lorentzianAdxThreshold,
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

function unrealizedPnl(position: Position, markPrice: number): number {
  const dir = position.side === "long" ? 1 : -1
  const qty = position.remainingQuantity ?? position.quantity
  return (markPrice - position.entryPrice) * dir * qty
}

// Pearson correlation of close-to-close returns over the overlapping window.
// Used by the sniper to avoid entering two coins that move in lockstep.
function priceCorrelation(a: Candle[], b: Candle[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 30) return 0
  const ra: number[] = []
  const rb: number[] = []
  for (let i = 1; i < n; i++) {
    ra.push((a[i].close - a[i - 1].close) / a[i - 1].close)
    rb.push((b[i].close - b[i - 1].close) / b[i - 1].close)
  }
  const m = ra.length
  const meanA = ra.reduce((sum, v) => sum + v, 0) / m
  const meanB = rb.reduce((sum, v) => sum + v, 0) / m
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < m; i++) {
    const da = ra[i] - meanA
    const db = rb[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  if (denA === 0 || denB === 0) return 0
  return num / Math.sqrt(denA * denB)
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
    const mexPositions = (await getMexcOpenPositions()) as any[]
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
  strategy: "trend" | "range" | "webhook" | "scalp" | "sniper" = "trend",
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
  // Explicit overrides (scalper/sniper) win; otherwise strategy default.
  let stopLoss: number
  let takeProfit: number
  let rangeTarget: number | null = null
  if (opts?.stopLoss != null && opts?.takeProfit != null) {
    stopLoss = opts.stopLoss
    takeProfit = opts.takeProfit
  } else if (strategy === "range") {
    // Mean-reversion targets — TP at the middle of the range, tight SL just
    // beyond the range boundary (breakout = premise dead).
    rangeTarget = snap.bbMiddle
    takeProfit = snap.bbMiddle
    stopLoss = direction === "long" ? price - snap.atr * 1.0 : price + snap.atr * 1.0
  } else {
    const stops = computeInitialStops(direction, price, snap.atr, cfg)
    stopLoss = stops.stopLoss
    takeProfit = stops.takeProfit
  }

  // Effective margin for this position: honor a risk-based size override when
  // provided (trend scalper), but never below a small floor or above the
  // configured size AND the remaining margin budget.
  const MIN_MARGIN_USDT = 5
  const budget = marginBudgetRemaining()
  let sizeUsdt = cfg.positionSizeUsdt

  // Risk-based sizing: normalize per-trade dollar risk to a fixed target.
  // sizeUsdt = targetRiskUsdt * entry / (leverage * risk), capped at the
  // per-position ceiling and the remaining margin budget. A wide-stop coin
  // gets less margin, a tight-stop coin gets more — same dollars at risk.
  if (strategy === "sniper" && cfg.sniperTargetRiskUsdt != null && cfg.sniperTargetRiskUsdt > 0) {
    const risk = Math.abs(price - stopLoss)
    if (risk > 0) {
      const riskSized = (cfg.sniperTargetRiskUsdt * price) / (cfg.leverage * risk)
      sizeUsdt = Math.min(sizeUsdt, riskSized)
    }
  }

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

  const quantity = (sizeUsdt * cfg.leverage) / price

  if (cfg.mode === "live") {
    try {
      const tickerCache = new Map()
    const exchange = getExchangeClient(cfg.exchange as Exchange)
      await exchange.placeMarketOrder({
        symbol: cfg.symbol,
        side: direction === "long" ? 1 : 3,
        volume: quantity,
        leverage: cfg.leverage,
      })
    } catch (err) {
      await log("error", `LIVE order failed: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }

  const openFee = sizeUsdt * cfg.leverage * TAKER_FEE

  await db.insert(positions).values({
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    side: direction,
    entryPrice: price,
    sizeUsdt,
    quantity,
    leverage: cfg.leverage,
    stopLoss,
    takeProfit,
    highestPrice: price,
    lowestPrice: price,
    entryConfidence: confidence,
    entryFeatures: features as unknown as Record<string, number>,
    atrAtEntry: snap.atr,
    strategy,
    rangeTarget,
  })

  await db
    .update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} - ${openFee}` })
    .where(eq(botConfig.id, 1))

  await log(
    "trade",
    `Opened ${direction.toUpperCase()} [${strategy}] @ ${price.toFixed(2)} | size ${sizeUsdt.toFixed(2)} USDT x${cfg.leverage} | SL ${stopLoss.toFixed(2)} TP ${takeProfit.toFixed(2)} | confidence ${(confidence * 100).toFixed(1)}%`,
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

  if (cfg.mode === "live") {
    try {
      const exchange = getExchangeClient(cfg.exchange as Exchange)
      await exchange.placeMarketOrder({
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
  }

  const dir = position.side === "long" ? 1 : -1
  const grossPnl = (exitPrice - position.entryPrice) * dir * closeQty
  const closeFee = position.sizeUsdt * position.leverage * TAKER_FEE * fraction
  const netPnl = grossPnl - closeFee

  await db.insert(trades).values({
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    sizeUsdt: position.sizeUsdt * fraction,
    leverage: position.leverage,
    pnl: netPnl,
    fees: closeFee,
    exitReason: "partial",
    strategy: position.strategy ?? "trend",
    entryConfidence: position.entryConfidence,
    openedAt: position.openedAt,
    partial: true,
  })

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
    `Partial close ${position.side.toUpperCase()} @ ${exitPrice.toFixed(2)} | ${(fraction * 100).toFixed(0)}% of position | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT | SL → break-even`,
  )
}

export async function closePosition(
  position: Position,
  exitPrice: number,
  reason: "tp" | "sl" | "trail" | "signal" | "manual" | "partial",
  cfg: BotConfig,
): Promise<void> {
  if (cfg.mode === "live") {
    try {
      const tickerCache = new Map()
    const exchange = getExchangeClient(cfg.exchange as Exchange)
      await exchange.placeMarketOrder({
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
  }

  const grossPnl = unrealizedPnl(position, exitPrice)
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
      exitPrice,
      sizeUsdt: remainingSize,
      leverage: position.leverage,
      pnl: netPnl,
      fees: closeFee,
      exitReason: reason,
      strategy: position.strategy ?? "trend",
      entryConfidence: position.entryConfidence,
      openedAt: position.openedAt,
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
    `Closed ${position.side.toUpperCase()} @ ${exitPrice.toFixed(2)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%) | reason: ${reason.toUpperCase()}`,
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
  const cfg = await getConfig()
  await reconcilePositions(cfg)
  console.log("TICK: bot running"); if (cfg.status !== "running") return { status: "skipped", detail: "Bot is stopped" }

  try {
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
      await log(
        "info",
        `⚠️ Risk layer HALTED new trades — ${risk.reasons.join("; ")} | equity ${risk.equity.toFixed(2)} day ${risk.dailyPnlPct >= 0 ? "+" : ""}${(risk.dailyPnlPct * 100).toFixed(1)}% dd ${(risk.drawdownPct * 100).toFixed(1)}%`,
      )
    }

    // Separate models per entry style so each learns its own edge (see MODEL_IDS):
    // the automated trend/momentum entry uses the trend model, the pullback
    // scalper uses the scalp model. Grid trains its own model inside grid.ts.
    const trendModel = await loadModelFor("trend")
    const scalpModel = await loadModelFor("scalp")
    const marks = new Map<string, number>()

    const tickerCache = new Map()
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    // ── Sniper scan (decoupled universe) ──
    // Runs every tick (~5min). DNA pre-filter in sniper.ts skips oscillating
    // coins. Only detects on trending-with-pullbacks regimes.
    try {
      const sniperCandidates = await runSniperCycle()
      if (sniperCandidates.length > 0) {
        await log("info", `Sniper cycle found ${sniperCandidates.length} candidate(s): ${sniperCandidates.map(c => c.symbol).join(', ')}`)
      }
    } catch (err) {
      await log("error", `Sniper cycle error: ${err instanceof Error ? err.message : 'unknown'}`)
    }

    // ── Sniper scan (decoupled universe) ──
    // Runs every tick (~5min). DNA pre-filter in sniper.ts skips oscillating
    // coins. Only detects on trending-with-pullbacks regimes.
    try {
      const sniperCandidates = await runSniperCycle()
      if (sniperCandidates.length > 0) {
        await log("info", `Sniper cycle found ${sniperCandidates.length} candidate(s): ${sniperCandidates.map(c => c.symbol).join(', ')}`)
      }
    } catch (err) {
      await log("error", `Sniper cycle error: ${err instanceof Error ? err.message : 'unknown'}`)
    }

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
                finalAllowed: confirmation.allowed,
                reason,
              }).onConflictDoNothing()
              await log("info", `SCALP ${scalp.direction.toUpperCase()} candidate: ${reason}`, {
                scalpConfluence: scalp.confidence,
                mlConfidence: mlConf,
                lorentzianConfidence: lorentzian.confidence,
                rMultiple: scalp.rMultiple,
              })
              if (confirmation.allowed) {
                await openPosition(marketCfg, scalp.direction, snap, blended, scalpFeatures, "scalp", {
                  sizeUsdtOverride: scalp.suggestedSizeUsdt ?? undefined,
                  stopLoss: scalp.stopLoss ?? undefined,
                  takeProfit: scalp.takeProfit ?? undefined,
                })
                scalpHandled = true
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
            await log("info", `${signal.candidateDirection.toUpperCase()} [${signal.strategy}] candidate: ${reason}`, {
              logisticConfidence: signal.confidence,
              lorentzianConfidence: lorentzian.confidence,
              lorentzianVote: lorentzian.vote,
              confirmationMode: marketCfg.confirmationMode,
            })
            if (confirmation.allowed) {
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
              if (advCfg.smartMoneyEnabled) {
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

    try {
      await maybeRunGridAiAdvisorAuto()
    } catch (err) { /* best-effort */ }

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
        const assets = await getAccountAssets()
        const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
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

    // Sniper scan: rule-based liquidity-sweep / sigma-exhaustion signal.
    // Best-effort — must never throw and break the live trading loop.
    try {
      const fresh = await runSniperCycle()
      if (cfg.sniperLive && fresh.length > 0) {
        // Option B: enter only the top N candidates by confidence, not every
        // signal. The margin cap inside openPosition still applies on top.
        const floor = cfg.sniperConfidenceFloor ?? 0.6
        console.log(`[Sniper Auto] fresh=${fresh.length}, floor=${floor}, candidates:`, fresh.map(c => `${c.symbol}(${c.confidence.toFixed(2)})`).join(', '))
        const ranked = [...fresh]
          .filter((c) => c.confidence >= floor)
          .sort((a, b) => b.confidence - a.confidence)
        console.log(`[Sniper Auto] after confidence filter: ${ranked.length} signals`)
        const heldSymbols = new Set((await getOpenPositions()).map((p) => p.symbol))
        let remainingBudget = marginBudgetRemaining()
        console.log(`[Sniper] auto-exec: ranked=${ranked.length} budget=${remainingBudget.toFixed(2)}`)

        // ── Correlation dedup ──
        // Fetch klines for all ranked candidates up front and compute pairwise
        // correlation, so we skip any coin that moves in lockstep with a
        // higher-confidence pick (avoids doubling down on one market move).
        const CORR_THRESHOLD = cfg.sniperCorrThreshold ?? 0.8
        const klineMap = new Map<string, Candle[]>()
        for (const c of ranked) {
          if (heldSymbols.has(c.symbol)) continue
          try {
            const k = await exchange.fetchKlines(toExchangeSymbol(c.symbol), c.timeframe, 200)
            if (k.length >= 60) klineMap.set(c.symbol, k)
          } catch { console.log(`[Sniper] kline fetch failed for ${c.symbol}`) }
        }
        console.log(`[Sniper Auto] held symbols: ${Array.from(heldSymbols).join(', ') || 'none'}`)
        const picked: string[] = []
        for (const c of ranked) {
          if (heldSymbols.has(c.symbol)) continue
          const k = klineMap.get(c.symbol)
          if (!k) { console.log(`[Sniper] no klines for ${c.symbol}, skip`); continue }
          let bestCorr = 0
          let bestSym = ""
          for (const sym of picked) {
            const pk = klineMap.get(sym)
            if (!pk) continue
            const corr = priceCorrelation(k, pk)
            if (corr > bestCorr) { bestCorr = corr; bestSym = sym }
          }
          if (bestCorr >= CORR_THRESHOLD) {
            await log("info", `Sniper: skipped ${c.symbol} (corr ${bestCorr.toFixed(2)} vs ${bestSym}, >= ${CORR_THRESHOLD})`)
          } else {
            picked.push(c.symbol)
            await log("info", `Sniper: picked ${c.symbol} (max corr ${bestCorr.toFixed(2)}${bestSym ? ` vs ${bestSym}` : ""}, < ${CORR_THRESHOLD})`)
          }
        }
        const selected = picked.slice(0, Math.max(1, cfg.sniperMaxEntries ?? 3))

        for (const sym of selected) {
          const c = ranked.find((r) => r.symbol === sym)
          if (!c) continue
          try {
            heldSymbols.add(c.symbol)
            const marketCfg: BotConfig = {
              ...cfg,
              symbol: c.symbol,
              timeframe: c.timeframe,
              leverage: cfg.sniperLeverage ?? cfg.leverage,
              positionSizeUsdt: cfg.sniperPositionSizeUsdt ?? cfg.positionSizeUsdt,
            } as BotConfig
            const candles = await exchange.fetchKlines(toExchangeSymbol(c.symbol), c.timeframe, 200)
            if (candles.length < 60) continue
            const snap = computeSnapshot(candles, marketCfg)
            snap.price = c.entry
            const features: FeatureVector = { ...snap.features, sideLong: c.direction === "long" ? 1 : -1 }
            const used = await openPosition(marketCfg, c.direction, snap, c.confidence, features, "sniper", {
              stopLoss: c.stopLoss,
              takeProfit: c.takeProfit,
              sizeUsdtOverride: remainingBudget > 0 ? remainingBudget : (cfg.sniperPositionSizeUsdt ?? cfg.positionSizeUsdt),
            })
            remainingBudget -= Math.min(used, remainingBudget)
          } catch (err) {
            console.error("[Sniper] live entry failed:", err)
          }
        }
      }
    } catch (err) {
      console.error("[Sniper] cycle error:", err)
    }

    return { status: "ok" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await log("error", `Tick failed: ${message}`)
    return { status: "error", detail: message }
  }
}


// --- Real-time WebSocket Engine ---
export async function initRealtimeEngine(symbol: string, timeframe: string) {
  if (!(globalThis as any).__wsManagers) (globalThis as any).__wsManagers = {}
  // If a WS already exists for this symbol, don't create a duplicate
  if ((globalThis as any).__wsManagers[symbol]) return
  
  console.log(`[Engine] Initializing real-time WebSocket engine for ${symbol}...`)
  const manager = new MexcWebSocketManager(symbol, timeframe, async (kline) => {
    if (kline.isClosed) {
      console.log(`[WS] ${symbol} candle closed. Triggering instant tick...`)
      try {
        await runTick()
      } catch (err) {
        console.error(`[WS] Error during ${symbol} WS-triggered tick:`, err)
      }
    }
  })
  
  // Connect the WebSocket
  await manager.connect()
  console.log(`[Engine] WebSocket connected for ${symbol}`)
  
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

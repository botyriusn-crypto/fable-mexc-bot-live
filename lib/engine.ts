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
  gridConfigs,
} from "./db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { type Candle } from "./mexc/public"
import { getExchangeClient, type Exchange } from "./exchange"
import { classifyLorentzian, combineConfirmation } from "./lorentzian"
import { computeSnapshot, getFeatures, type FeatureVector, type IndicatorSnapshot } from "./indicators"
import { loadModel, trainOnTrade, gateEntry } from "./ml"
import { evaluateEntry, isOppositeSignal, detectRegime } from "./strategy"
import { detectSniper, SNIPER_LIVE } from "./sniper"
import { runGridTick, gridUnrealizedPnl, getGridConfigs } from "./grid"
import { computeInitialStops, evaluateExit } from "./exits"
import { MexcWebSocketManager, livePrices, livePriceTimestamps } from "./mexc/ws"

// Chandelier Exit calculation: Trails from highest high/lowest low
function calcChandelierExit(isLong: boolean, extremePrice: number, atr: number, mult: number): number {
  const safeMult = Math.max(1, mult) // Ensure multiplier is at least 1
  return isLong ? extremePrice - (atr * safeMult) : extremePrice + (atr * safeMult)
}

const TAKER_FEE = 0.0002 // 0.02%

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

async function log(level: "info" | "trade" | "error", message: string, details?: unknown) {
  await db.insert(botLogs).values({
    level,
    message,
    details: details ? (details as Record<string, unknown>) : null,
  })
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
  return (markPrice - position.entryPrice) * dir * position.quantity
}

async function openPosition(
  cfg: BotConfig,
  direction: "long" | "short",
  snap: IndicatorSnapshot,
  confidence: number,
  features: FeatureVector,
  strategy: "trend" | "range" | "webhook" = "trend",
): Promise<void> {
  const price = snap.price
  const quantity = (cfg.positionSizeUsdt * cfg.leverage) / price

  // Range strategy: mean-reversion targets — TP at the middle of the range,
  // tight SL just beyond the range boundary (breakout = premise dead).
  let stopLoss: number
  let takeProfit: number
  let rangeTarget: number | null = null
  if (strategy === "range") {
    rangeTarget = snap.bbMiddle
    takeProfit = snap.bbMiddle
    stopLoss = direction === "long" ? price - snap.atr * 1.0 : price + snap.atr * 1.0
  } else {
    const stops = computeInitialStops(direction, price, snap.atr, cfg)
    stopLoss = stops.stopLoss
    takeProfit = stops.takeProfit
  }

  if (cfg.mode === "live") {
    try {
      const exchange = getExchangeClient(cfg.exchange as Exchange)
      await exchange.placeMarketOrder({
        symbol: cfg.symbol,
        side: direction === "long" ? 1 : 3,
        volume: quantity,
        leverage: cfg.leverage,
      })
    } catch (err) {
      await log("error", `LIVE order failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }

  const openFee = cfg.positionSizeUsdt * cfg.leverage * TAKER_FEE

  await db.insert(positions).values({
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    side: direction,
    entryPrice: price,
    sizeUsdt: cfg.positionSizeUsdt,
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
    `Opened ${direction.toUpperCase()} [${strategy}] @ ${price.toFixed(2)} | size ${cfg.positionSizeUsdt} USDT x${cfg.leverage} | SL ${stopLoss.toFixed(2)} TP ${takeProfit.toFixed(2)} | ML confidence ${(confidence * 100).toFixed(1)}%`,
  )
}

export async function closePosition(
  position: Position,
  exitPrice: number,
  reason: "tp" | "sl" | "trail" | "signal" | "manual",
  cfg: BotConfig,
): Promise<void> {
  if (cfg.mode === "live") {
    try {
      const exchange = getExchangeClient(cfg.exchange as Exchange)
      await exchange.placeMarketOrder({
        symbol: position.symbol,
        side: position.side === "long" ? 4 : 2,
        volume: position.quantity,
        leverage: position.leverage,
      })
    } catch (err) {
      await log("error", `LIVE close failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }

  const grossPnl = unrealizedPnl(position, exitPrice)
  const closeFee = position.sizeUsdt * position.leverage * TAKER_FEE
  const netPnl = grossPnl - closeFee
  const pnlPct = (netPnl / position.sizeUsdt) * 100

  const [trade] = await db
    .insert(trades)
    .values({
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      sizeUsdt: position.sizeUsdt,
      leverage: position.leverage,
      pnl: netPnl,
      fees: closeFee,
      exitReason: reason,
      strategy: position.strategy ?? "trend",
      entryConfidence: position.entryConfidence,
      openedAt: position.openedAt,
      live: cfg.mode === "live",
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

  // Learning loop: every closed trade trains the model
  if (position.entryFeatures) {
    try {
      await trainOnTrade(
        position.entryFeatures as unknown as Record<string, number>,
        netPnl > 0 ? 1 : -1,
        pnlPct,
        "trend"
      )
      await log("info", `Model updated from trade #${trade.id} (${netPnl > 0 ? "win" : "loss"})`)
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
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    await new Promise(r => setTimeout(r, 200)); // 200ms delay to prevent MEXC rate limits
        const [candles, ticker] = await Promise.all([
      exchange.fetchKlines(cfg.symbol, cfg.timeframe, cfg.lorentzianWebhooks ? Math.max(200, cfg.lorentzianLookback + 40) : 200),
      exchange.fetchTicker(cfg.symbol),
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

    const model = await loadModel()
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


async function syncWithMexc(cfg: BotConfig) {
  if (cfg.mode !== "live") return

  try {
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    const mexPositions = await exchange.getOpenPositions() as any[]

    if (Array.isArray(mexPositions)) {
      // Get all DB pending orders
      const dbOrders = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))

      // Get MEXC open orders - these are the real ones
      const mexcSymbols = new Set(mexPositions.map((p: any) => p.symbol))

      // Cancel any DB orders for symbols that have NO real MEXC positions
      for (const order of dbOrders) {
        if (!mexcSymbols.has(order.symbol)) {
          await db.update(gridOrders)
            .set({ status: "cancelled" })
            .where(eq(gridOrders.id, order.id))
        }
      }

      // Log the sync
      const cancelledCount = dbOrders.filter(o => !mexcSymbols.has(o.symbol)).length
      if (cancelledCount > 0) {
        await log("info", `Synced with MEXC: cancelled ${cancelledCount} ghost orders`)
      }
    }
  } catch (err) {
    // Sync is best-effort, don't block trading
  }
}

let isTicking = false

export async function runTick(): Promise<{ status: string; detail?: string }> {
  if (isTicking) return { status: "skipped", detail: "Tick already in progress" }
  isTicking = true
  const cfg = await getConfig()
  if (cfg.status !== "running") return { status: "skipped", detail: "Bot is stopped" }
  // Sync with MEXC to remove ghost orders
  await syncWithMexc(cfg)

  try {
    const [openPositions, activeGrid] = await Promise.all([
      getOpenPositions(),
      db.select().from(gridOrders).where(eq(gridOrders.status, "pending")),
    ])
    const marketKeys = new Set<string>([`${cfg.symbol}|${cfg.timeframe}`])
    for (const pos of openPositions) marketKeys.add(`${pos.symbol}|${pos.timeframe}`)
    for (const order of activeGrid) marketKeys.add(`${order.symbol}|${order.timeframe}`)

    const model = await loadModel()
    const marks = new Map<string, number>()
    const tickerCache = new Map<string, any>()
    const exchange = getExchangeClient(cfg.exchange as Exchange)
    const gridCfgs = await getGridConfigs()

    for (const gc of gridCfgs) {
      try {
        await new Promise(r => setTimeout(r, 200)); // 200ms delay to prevent MEXC rate limits
        const [candles, ticker] = await Promise.all([
          exchange.fetchKlines(gc.symbol, gc.timeframe, 200),
          tickerCache.get(gc.symbol) || exchange.fetchTicker(gc.symbol).then((t: any) => { tickerCache.set(gc.symbol, t); return t; })
        ])
        if (candles.length < 60) { await log("error", `Grid ${gc.symbol}: insufficient candles`); continue }
        const snap = computeSnapshot(candles, { ...cfg, symbol: gc.symbol, timeframe: gc.timeframe })
        snap.price = ticker.lastPrice
        marks.set(gc.symbol, snap.price)
        // Regime-aware auto-tuning: wider ATR in trending, tighter in ranging
        const regime = detectRegime(snap, { ...cfg, symbol: gc.symbol, timeframe: gc.timeframe })
        if (gc.direction.startsWith("auto")) {
          // 1. Auto-Tune ATR Spacing
          if (regime === "trend" && gc.rangeAtrMult < 2.0) {
            await db.update(gridConfigs).set({ rangeAtrMult: Math.min(gc.rangeAtrMult * 1.3, 3.0) }).where(eq(gridConfigs.id, gc.id))
            gc.rangeAtrMult = Math.min(gc.rangeAtrMult * 1.3, 3.0)
          } else if (regime === "range" && gc.rangeAtrMult > 0.8) {
            await db.update(gridConfigs).set({ rangeAtrMult: Math.max(gc.rangeAtrMult * 0.9, 0.5) }).where(eq(gridConfigs.id, gc.id))
            gc.rangeAtrMult = Math.max(gc.rangeAtrMult * 0.9, 0.5)
          }

          // 2. Auto-Direction Detection (Macro Trend: EMA 50 vs EMA 200)
          const closes = candles.map(c => c.close)
          const getEma = (vals: number[], p: number) => {
            const k = 2 / (p + 1); let prev = vals[0] || 0;
            for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); }
            return prev;
          }
          const emaFast = getEma(closes, 50)
          const emaSlow = getEma(closes, 200)
          const newDir = emaFast > emaSlow ? "auto-long" : "auto-short"
          
          if (gc.direction !== newDir) {
            try {
              await db.update(gridConfigs).set({ direction: newDir }).where(eq(gridConfigs.id, gc.id))
              gc.direction = newDir
              await log("info", `Grid ${gc.symbol}: Auto-direction updated to ${newDir}`)
            } catch (e) {}
          }
          (gc as any)._autoSide = newDir === "auto-long" ? "long" : "short"
        }
        await runGridTick(cfg, gc, snap, regime, exchange)
      } catch (err) {
        await log("error", `Grid ${gc.symbol} tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    for (const key of marketKeys) {
      const [symbol, timeframe] = key.split("|")
      const marketCfg = { ...cfg, symbol, timeframe }
      try {
        const isSelected = symbol === cfg.symbol && timeframe === cfg.timeframe
        const candleLimit = isSelected ? Math.max(200, cfg.lorentzianLookback + 40) : 200
        await new Promise(r => setTimeout(r, 200)); // 200ms delay to prevent MEXC rate limits
        const candles = await exchange.fetchKlines(symbol, timeframe, candleLimit)
        // Use live WebSocket price if available, otherwise fall back to candle close
        const livePrice = livePrices[symbol] || candles[candles.length - 1].close
        const ticker = { lastPrice: livePrice }
        
        // WebSocket Staleness Check
        const lastUpdate = livePriceTimestamps[symbol] || 0
        if (Date.now() - lastUpdate > 30000 && livePrices[symbol]) {
          console.error(`[Engine] Stale WebSocket price for ${symbol} (last update >30s ago). Forcing reconnect.`)
          const manager = globalThis.__wsManagers?.[symbol]
          if (manager) manager.disconnect() // Triggers automatic reconnect
          continue // Skip this tick to avoid trading on frozen price
        }
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
            marketPosition.strategy === "trend" &&
            isOppositeSignal(snap, marketPosition.side as "long" | "short")
          const decision = evaluateExit(marketPosition, snap, marketCfg, opposite)
          if (decision.action === "close") {
            await closePosition(marketPosition, snap.price, decision.reason!, marketCfg)
          } else if (Object.keys(decision.updates).length > 0) {
            await db.update(positions).set(decision.updates).where(eq(positions.id, marketPosition.id))
          }
        }

        if (isSelected) await resolveClassifierOutcomes(symbol, timeframe, candles)
        // ── Sniper Engine v1: event-driven dislocation scanner (observe-only) ──
if (isSelected) {
try {
const realTicker = await exchange.fetchTicker(symbol)
const sn = detectSniper(candles, snap, (realTicker as any)?.fundingRate ?? 0)
if (sn.direction) {
const nowTs = Date.now()
const lastLog = ((globalThis as any).__sniperLast ?? {})[symbol] ?? 0
if (nowTs - lastLog > 6 * 3600 * 1000) {
;(globalThis as any).__sniperLast = { ...((globalThis as any).__sniperLast ?? {}), [symbol]: nowTs }
await log("info", `🎯 SNIPER CANDIDATE ${symbol}: ${sn.direction.toUpperCase()} | ${sn.reason} | conf ${(sn.confidence * 100).toFixed(0)}% | SL ${sn.stopLoss.toFixed(6)} | TP ${sn.takeProfit.toFixed(6)}`)
if (SNIPER_LIVE && (sn.direction === "long" ? marketCfg.allowLong : marketCfg.allowShort)) {
await openPosition(marketCfg, sn.direction, snap, sn.confidence, { ...snap.features, sideLong: sn.direction === "long" ? 1 : -1 }, "sniper", { stopLoss: sn.stopLoss, takeProfit: sn.takeProfit })
}
}
}
} catch (err) {
await log("error", `Sniper scan failed: ${err instanceof Error ? err.message : String(err)}`)
}
}
if (isSelected && !marketPosition) {
          const signal = evaluateEntry(snap, candles, marketCfg, model)
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
              await openPosition(marketCfg, signal.candidateDirection, snap, signal.confidence, signal.features, signal.strategy)
            }
          }
        }

      // Grid already handled by multi-pair loop above
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

    // ── AI Advisor: run analysis on schedule ──
    if (cfg.aiAdvisorEnabled && cfg.aiAnalysisSchedule !== "manual") {
      const now = new Date()
      const lastAnalysis = cfg.aiLastAnalysis ? new Date(cfg.aiLastAnalysis) : null
      let shouldRun = !lastAnalysis
      if (!shouldRun && cfg.aiAnalysisSchedule === "daily") shouldRun = now.getTime() - lastAnalysis!.getTime() > 86400000
      if (!shouldRun && cfg.aiAnalysisSchedule === "weekly") shouldRun = now.getTime() - lastAnalysis!.getTime() > 604800000
      if (shouldRun) {
        try {
          const result = await analyzeTradesForMarket(cfg.symbol, cfg.timeframe)
          if (result?.recommendations.length) {
            await log("info", `AI Advisor: ${result.recommendations.length} recommendations`)
            const highConfidence = result.recommendations.filter((r: any) =>
              typeof r.suggested === 'number' && typeof r.current === 'number' &&
              Math.abs(r.suggested - r.current) / Math.abs(r.current) < 0.5
            )
            if (highConfidence.length > 0) {
              await applyRecommendations(0, highConfidence)
              await log("info", `AI Advisor: auto-applied ${highConfidence.length} recommendations`)
            }
          }
          await db.update(botConfig).set({ aiLastAnalysis: now as any }).where(eq(botConfig.id, 1))
        } catch (err) {}
      }
    }

    await db.insert(equitySnapshots).values({
      balance: cfgAfter.paperBalance,
      equity: cfgAfter.paperBalance + totalUnrealized,
      unrealizedPnl: totalUnrealized,
    })
    return { status: "ok" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await log("error", `Tick failed: ${message}`)
    return { status: "error", detail: message }
  } finally {
    isTicking = false
  }
}

// --- Real-time WebSocket Engine ---
declare global {
  // eslint-disable-next-line no-var
  var __wsManagers: Record<string, MexcWebSocketManager> | undefined
}

export async function initRealtimeEngine(symbol: string, timeframe: string) {
  if (!globalThis.__wsManagers) globalThis.__wsManagers = {}
  // If a WS already exists for this symbol, don't create a duplicate
  if (globalThis.__wsManagers[symbol]) return
  
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
  
  globalThis.__wsManagers[symbol] = manager
  manager.connect()
}

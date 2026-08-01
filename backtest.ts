// Backtester v3 — with debug to trace why signals are rejected
// Usage: npx tsx backtest.ts BTC_USDT Min5 30 --mtf --debug

import { computeSnapshot, type FeatureVector } from "./lib/indicators"
import { detectRegime, isOppositeSignal, type Signal } from "./lib/strategy"
import { evaluateExit, computeInitialStops } from "./lib/exits"
import { classifyLorentzian, combineConfirmation } from "./lib/lorentzian"
import { gateEntry, FEATURE_KEYS, type MlState } from "./lib/ml"

const args = process.argv.slice(2)
const symbol = args[0] ?? "BTC_USDT"
const timeframe = args[1] ?? "Min5"
const daysBack = parseInt(args[2] ?? "30")
const useMTF = args.includes("--mtf")
const useAtrSize = args.includes("--atr-size")
const debug = args.includes("--debug")

const CFG = {
  symbol, timeframe,
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
  atrPeriod: 14, strategyMode: "auto" as const,
  adxTrendThreshold: 25, adxRangeThreshold: 20,
  bbPeriod: 20, bbStd: 2, slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2,
  momentumThreshold: 0.6, mlConfidenceThreshold: 0.55, mlLearningRate: 0.05,
  confirmationMode: "observe" as const,
  lorentzianConfidenceThreshold: 0.2, lorentzianNeighbors: 5, lorentzianLookback: 100,
  lorentzianUseVolatilityFilter: false, lorentzianUseRegimeFilter: false,
  lorentzianUseAdxFilter: false, lorentzianRegimeThreshold: -0.1,
  lorentzianAdxThreshold: 20, lorentzianKernelFilter: false,
  leverage: 5, positionSizeUsdt: 500, allowLong: true, allowShort: true,
  atrRiskPct: 1.0,
}

const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Position { side: "long" | "short"; entryPrice: number; sizeUsdt: number; quantity: number; leverage: number; stopLoss: number; takeProfit: number; trailingStop?: number; trailingActive: boolean; breakEvenMoved: boolean; highestPrice: number; lowestPrice: number; entryConfidence: number; atrAtEntry: number; strategy: "trend" | "range"; openedAt: number }
interface Trade { side: string; strategy: string; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; exitReason: string; openedAt: number; closedAt: number }

function evaluateEntryBroad(snap: any, cfg: any, model: MlState): Signal {
  const regime = detectRegime(snap, cfg)
  let strategy: "trend" | "range" | null = null
  if (cfg.strategyMode === "trend") strategy = "trend"
  else if (cfg.strategyMode === "range") strategy = "range"
  else if (regime === "trend") strategy = "trend"
  else if (regime === "range") strategy = "range"

  if (!strategy) {
    return { direction: null, candidateDirection: null, baseTriggered: false, mlAllowed: false, confidence: 0, features: null, strategy: "trend", regime, reason: `Neutral regime (ADX ${snap.adx.toFixed(1)})` }
  }

  let direction: "long" | "short" | null = null
  let blockedReason = ""

  if (strategy === "trend") {
    const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
    const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow
    const alreadyBullish = snap.emaFast > snap.emaSlow && snap.prevEmaFast > snap.prevEmaSlow
    const alreadyBearish = snap.emaFast < snap.emaSlow && snap.prevEmaFast < snap.prevEmaSlow

    if ((bullishCross || alreadyBullish) && snap.rsi < cfg.rsiOverbought && cfg.allowLong) direction = "long"
    else if ((bearishCross || alreadyBearish) && snap.rsi > cfg.rsiOversold && cfg.allowShort) direction = "short"
    else if (alreadyBullish || alreadyBearish) blockedReason = `EMA aligned but RSI ${snap.rsi.toFixed(1)} or side toggle`
    else blockedReason = "No EMA crossover or alignment"
  } else {
    const atLower = snap.price <= snap.bbLower
    const atUpper = snap.price >= snap.bbUpper
    if (atLower && snap.rsi <= cfg.rsiOversold && cfg.allowLong) direction = "long"
    else if (atUpper && snap.rsi >= cfg.rsiOverbought && cfg.allowShort) direction = "short"
    else if (atLower || atUpper) blockedReason = "Band touch blocked by RSI or side toggle"
    else blockedReason = "Price inside range"
  }

  if (!direction) {
    return { direction: null, candidateDirection: null, baseTriggered: false, mlAllowed: false, confidence: 0, features: null, strategy, regime, reason: blockedReason }
  }

  const features: FeatureVector = { ...snap.features, sideLong: direction === "long" ? 1 : -1 }
  const { allowed, confidence } = gateEntry(model, features, cfg.mlConfidenceThreshold)

  return {
    direction: allowed ? direction : null, candidateDirection: direction, baseTriggered: true,
    mlAllowed: allowed, confidence, features, strategy, regime,
    reason: allowed ? `${direction.toUpperCase()} [${strategy}] ML ${(confidence*100).toFixed(0)}%` : `${direction.toUpperCase()} [${strategy}] rejected by ML (${(confidence*100).toFixed(0)}%)`,
  }
}

function createModel(): MlState {
  return { weights: Object.fromEntries(FEATURE_KEYS.map(k => [k, 0])), bias: 0, sampleCount: 0, correctCount: 0, rollingAccuracy: 0.5 }
}
function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)) }
function predict(model: MlState, features: FeatureVector): number {
  let z = model.bias
  for (const key of FEATURE_KEYS) z += (model.weights[key] ?? 0) * (features[key] ?? 0)
  return sigmoid(z)
}
function trainOnline(model: MlState, features: FeatureVector, won: boolean, pnlPct: number): MlState {
  const label = won ? 1 : 0
  const prediction = predict(model, features)
  const error = prediction - label
  const pnlWeight = Math.min(1 + Math.abs(pnlPct) / 2, 3)
  const lr = CFG.mlLearningRate * pnlWeight
  const newWeights = { ...model.weights }
  for (const key of FEATURE_KEYS) {
    const grad = error * (features[key] ?? 0)
    newWeights[key] = (newWeights[key] ?? 0) - lr * grad - lr * 0.01 * (newWeights[key] ?? 0)
  }
  const newBias = model.bias - lr * error
  const predictedWin = prediction >= 0.5
  return {
    weights: newWeights, bias: newBias, sampleCount: model.sampleCount + 1,
    correctCount: model.correctCount + (predictedWin === won ? 1 : 0),
    rollingAccuracy: model.sampleCount === 0 ? (predictedWin === won ? 1 : 0) : model.rollingAccuracy * 0.9 + (predictedWin === won ? 1 : 0) * 0.1,
  }
}

function mtfAligned(window: Candle[], direction: "long" | "short"): boolean {
  const closes = window.map(c => c.close)
  const emaFast15 = ema(closes, 9 * 3)
  const emaSlow15 = ema(closes, 21 * 3)
  const i = closes.length - 1
  if (i < 60) return true
  return direction === "long" ? emaFast15[i] > emaSlow15[i] : emaFast15[i] < emaSlow15[i]
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

async function fetchAllCandles(symbol: string, interval: string, endSec: number, daysBack: number): Promise<Candle[]> {
  const intervalSec = { Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Day1: 86400 }[interval] ?? 300
  const startSec = endSec - daysBack * 86400
  const all: Candle[] = []
  let fetchEnd = endSec
  console.log(`Fetching ${symbol} ${interval} for ${daysBack} days...`)
  while (true) {
    const fetchStart = Math.max(startSec, fetchEnd - 2000 * intervalSec)
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&start=${fetchStart}&end=${fetchEnd}`
    try {
      const res = await fetch(url, { cache: "no-store" })
      const json = await res.json() as any
      if (!json.success || !json.data?.time?.length) break
      const { time, open, high, low, close, vol } = json.data
      for (let i = 0; i < time.length; i++) {
        if (time[i] >= startSec && time[i] <= endSec) {
          all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
        }
      }
      const firstInBatch = time[0]
      console.log(`  ${new Date(firstInBatch * 1000).toISOString().split("T")[0]} — ${time.length} candles, total: ${all.length}`)
      if (firstInBatch <= startSec || time.length < 100) break
      fetchEnd = firstInBatch - intervalSec
    } catch (err) { console.error(`  Error: ${err}`); break }
  }
  all.sort((a, b) => a.time - b.time)
  const seen = new Set<number>()
  return all.filter(c => seen.has(c.time) ? false : (seen.add(c.time), true))
}

async function backtest() {
  const endSec = Math.floor(Date.now() / 1000)
  const candles = await fetchAllCandles(symbol, timeframe, endSec, daysBack)
  console.log(`Total deduplicated candles: ${candles.length}\n`)
  if (candles.length < 200) { console.error(`Need >= 200 candles, got ${candles.length}`); return }

  let model = createModel()
  let position: Position | null = null
  const trades: Trade[] = []
  let equity = 10000
  let lastEntryTime = 0
  let lastEntryDirection: string | null = null
  let mtfSkips = 0
  let candidateCount = 0
  let rejectedByLorentzian = 0
  let rejectedByML = 0
  let rejectedLog: Array<{ date: string; direction: string; strategy: string; reason: string }> = []

  for (let i = 200; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, CFG)
    const lorentzian = classifyLorentzian(window, {
      ...CFG, neighbors: CFG.lorentzianNeighbors,
      lookback: Math.min(CFG.lorentzianLookback, window.length - 80),
    })

    // Exit
    if (position) {
      const opposite = position.strategy === "trend" && isOppositeSignal(snap, position.side)
      const decision = evaluateExit({
        side: position.side, entryPrice: position.entryPrice, sizeUsdt: position.sizeUsdt,
        quantity: position.quantity, leverage: position.leverage, stopLoss: position.stopLoss,
        takeProfit: position.takeProfit, trailingStop: position.trailingStop,
        trailingActive: position.trailingActive, breakEvenMoved: position.breakEvenMoved,
        highestPrice: position.highestPrice, lowestPrice: position.lowestPrice,
        entryConfidence: position.entryConfidence, atrAtEntry: position.atrAtEntry,
        strategy: position.strategy, symbol, timeframe, id: 0, status: "open" as const,
        openedAt: new Date(position.openedAt * 1000), entryFeatures: null, rangeTarget: null, closedAt: null,
      }, snap, CFG, opposite)

      if (decision.action === "close") {
        const dir = position.side === "long" ? 1 : -1
        const grossPnl = (snap.price - position.entryPrice) * dir * position.quantity
        const fees = position.entryPrice * position.quantity * TAKER_FEE + snap.price * position.quantity * TAKER_FEE
        const netPnl = grossPnl - fees
        trades.push({
          side: position.side, strategy: position.strategy,
          entryPrice: position.entryPrice, exitPrice: snap.price,
          pnl: netPnl, pnlPct: (netPnl / position.sizeUsdt) * 100,
          exitReason: decision.reason ?? "unknown",
          openedAt: position.openedAt, closedAt: candles[i].time,
        })
        equity += netPnl
        model = trainOnline(model, { ...snap.features, sideLong: position.side === "long" ? 1 : -1 }, netPnl > 0, (netPnl / position.sizeUsdt) * 100)
        position = null
        lastEntryDirection = null
      } else if (Object.keys(decision.updates).length > 0) {
        Object.assign(position, decision.updates)
      }
    }

    // Entry
    if (!position) {
      const signal = evaluateEntryBroad(snap, CFG, model)
      const tooSoon = signal.strategy === "trend" && signal.candidateDirection === lastEntryDirection && candles[i].time - lastEntryTime < 900

      if (signal.baseTriggered && signal.candidateDirection && signal.features && !tooSoon) {
        candidateCount++
        
        // MTF filter
        if (useMTF && !mtfAligned(window, signal.candidateDirection)) {
          mtfSkips++
          if (debug && candidateCount <= 10) {
            console.log(`  [DEBUG] MTF skip: ${signal.candidateDirection} ${signal.strategy} @ ${new Date(candles[i].time * 1000).toISOString()}`)
          }
          continue
        }

        const confirmation = combineConfirmation(CFG.confirmationMode, signal.candidateDirection, signal.mlAllowed, lorentzian)
        
        if (!confirmation.allowed) {
          rejectedByLorentzian++
          if (debug && rejectedByLorentzian <= 10) {
            rejectedLog.push({
              date: new Date(candles[i].time * 1000).toISOString(),
              direction: signal.candidateDirection,
              strategy: signal.strategy,
              reason: `${confirmation.reason} | lorentzian: ${lorentzian.direction} vote ${lorentzian.vote}/${lorentzian.neighborCount} conf ${(lorentzian.confidence*100).toFixed(0)}% ready=${lorentzian.ready} allowed=${lorentzian.allowed} filters=${JSON.stringify(lorentzian.filters)}`,
            })
          }
        } else {
          const riskUsdt = useAtrSize ? equity * (CFG.atrRiskPct / 100) : CFG.positionSizeUsdt * 0.02
          const slDist = snap.atr * CFG.slAtrMult
          const sizeUsdt = slDist > 0 ? (riskUsdt * snap.price) / slDist : CFG.positionSizeUsdt
          const effectiveSize = Math.min(sizeUsdt, equity * 0.5)
          const quantity = (effectiveSize * CFG.leverage) / snap.price
          const stops = computeInitialStops(signal.candidateDirection, snap.price, snap.atr, CFG)

          position = {
            side: signal.candidateDirection, entryPrice: snap.price, sizeUsdt: effectiveSize,
            quantity, leverage: CFG.leverage, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
            trailingActive: false, breakEvenMoved: false, highestPrice: snap.price,
            lowestPrice: snap.price, entryConfidence: signal.confidence, atrAtEntry: snap.atr,
            strategy: signal.strategy, openedAt: candles[i].time,
          }
          lastEntryTime = candles[i].time
          lastEntryDirection = signal.candidateDirection
        }
      }
    }
  }

  // Close open position
  if (position) {
    const lastPrice = candles[candles.length - 1].close
    const dir = position.side === "long" ? 1 : -1
    const grossPnl = (lastPrice - position.entryPrice) * dir * position.quantity
    const fees = position.entryPrice * position.quantity * TAKER_FEE + lastPrice * position.quantity * TAKER_FEE
    const netPnl = grossPnl - fees
    trades.push({
      side: position.side, strategy: position.strategy,
      entryPrice: position.entryPrice, exitPrice: lastPrice, pnl: netPnl,
      pnlPct: (netPnl / position.sizeUsdt) * 100, exitReason: "eob",
      openedAt: position.openedAt, closedAt: candles[candles.length - 1].time,
    })
    equity += netPnl
  }

  // Stats
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0)
  const winRate = trades.length > 0 ? wins.length / trades.length : 0
  const profitFactor = grossLoss === 0 ? Infinity : wins.reduce((s, t) => s + t.pnl, 0) / grossLoss

  const eqCurve: number[] = [10000]
  let running = 10000
  for (const t of trades) { running += t.pnl; eqCurve.push(running) }
  let peak = 10000, maxDD = 0
  for (const e of eqCurve) { if (e > peak) peak = e; const dd = (peak - e) / peak * 100; if (dd > maxDD) maxDD = dd }

  console.log("═══════════════════════════════════════════")
  console.log(`  ${symbol} ${timeframe}  |  Last ${daysBack} days`)
  console.log(`  MTF: ${useMTF ? "ON" : "OFF"}  ATR-size: ${useAtrSize ? "ON" : "OFF"}`)
  console.log("═══════════════════════════════════════════")
  console.log(`  Candidates found: ${candidateCount}`)
  console.log(`  MTF skips:        ${mtfSkips}`)
  console.log(`  Rejected by ML:   ${rejectedByML}`)
  console.log(`  Rejected by Lore: ${rejectedByLorentzian}`)
  console.log(`  Trades executed:  ${trades.length}`)
  console.log(`  Win rate:         ${(winRate * 100).toFixed(1)}%`)
  console.log(`  Profit factor:    ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:        ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`)
  console.log(`  Max drawdown:     ${maxDD.toFixed(1)}%`)
  console.log(`  Final equity:     ${equity.toFixed(2)} USDT`)
  console.log(`  Model samples:    ${model.sampleCount}`)
  console.log("═══════════════════════════════════════════")

  if (rejectedLog.length > 0) {
    console.log(`\nSample Lorentzian rejections:`)
    for (const r of rejectedLog) {
      console.log(`  ${r.date} ${r.direction.toUpperCase()} ${r.strategy}: ${r.reason}`)
    }
  }

  if (trades.length > 0) {
    console.log(`\nAll trades:`)
    for (const t of trades) {
      const date = new Date(t.openedAt * 1000).toISOString().split("T")[0]
      console.log(`  ${date} ${t.side.toUpperCase().padEnd(5)} ${t.strategy.padEnd(5)} | ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} | ${t.exitReason}`)
    }
  }
}

backtest().catch(console.error)

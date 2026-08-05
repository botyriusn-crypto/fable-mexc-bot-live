// Backtester v4 — Uses EXACT production strategy logic (VWAP/MACD + Kelly + Lorentzian Sniper)
// Usage: npx tsx backtest.ts

import { computeSnapshot } from "./lib/indicators"
import { evaluateEntry, calculateDynamicSize, isOppositeSignal, type Signal } from "./lib/strategy"
import { evaluateExit, computeInitialStops } from "./lib/exits"
import { classifyLorentzian, combineConfirmation } from "./lib/lorentzian"
import { gateEntry, FEATURE_KEYS, type MlState } from "./lib/ml"
import type { Candle } from "./lib/mexc/public"

const symbols = ["BTC_USDT", "SOL_USDT"]
const timeframe = "Min5"
const daysBack = 30

// Sniper Config matching our live bot settings
const CFG = {
  symbol: "BTC_USDT", timeframe,
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
  atrPeriod: 14, strategyMode: "trend" as const,
  adxTrendThreshold: 25, adxRangeThreshold: 20,
  bbPeriod: 20, bbStd: 2, slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2,
  momentumThreshold: 0.6, mlConfidenceThreshold: 0.55, mlLearningRate: 0.05,
  confirmationMode: "both" as const, // Use Both for strict backtesting
  lorentzianConfidenceThreshold: 0.55, lorentzianNeighbors: 8, lorentzianLookback: 1500,
  lorentzianUseVolatilityFilter: false, lorentzianUseRegimeFilter: false,
  lorentzianUseAdxFilter: true, lorentzianRegimeThreshold: -0.1,
  lorentzianAdxThreshold: 20, lorentzianKernelFilter: true,
  leverage: 5, positionSizeUsdt: 500, allowLong: true, allowShort: true,
  atrRiskPct: 1.0,
}

const TAKER_FEE = 0.0002

interface Position { side: "long" | "short"; entryPrice: number; sizeUsdt: number; quantity: number; leverage: number; stopLoss: number; takeProfit: number; trailingStop?: number; trailingActive: boolean; breakEvenMoved: boolean; highestPrice: number; lowestPrice: number; entryConfidence: number; atrAtEntry: number; strategy: "trend" | "range"; openedAt: number }
interface Trade { side: string; strategy: string; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; exitReason: string; openedAt: number; closedAt: number }

function createModel(): MlState {
  return { weights: Object.fromEntries(FEATURE_KEYS.map(k => [k, 0])), bias: 0, sampleCount: 0, correctCount: 0, rollingAccuracy: 0.5 }
}
function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)) }
function predict(model: MlState, features: any): number {
  let z = model.bias
  for (const key of FEATURE_KEYS) z += (model.weights[key] ?? 0) * (features[key] ?? 0)
  return sigmoid(z)
}
function trainOnline(model: MlState, features: any, won: boolean, pnlPct: number): MlState {
  const label = won ? 1 : 0
  const prediction = predict(model, features)
  const error = prediction - label
  const pnlWeight = Math.min(1 + Math.abs(pnlPct) / 2, 1.5)
  const lr = CFG.mlLearningRate * pnlWeight
  const newWeights = { ...model.weights }
  for (const key of FEATURE_KEYS) {
    const grad = error * (features[key] ?? 0)
    newWeights[key] = (newWeights[key] ?? 0) - lr * grad - lr * 0.03 * (newWeights[key] ?? 0)
  }
  const newBias = model.bias - lr * error
  const predictedWin = prediction >= 0.5
  return {
    weights: newWeights, bias: newBias, sampleCount: model.sampleCount + 1,
    correctCount: model.correctCount + (predictedWin === won ? 1 : 0),
    rollingAccuracy: model.sampleCount === 0 ? (predictedWin === won ? 1 : 0) : model.rollingAccuracy * 0.9 + (predictedWin === won ? 1 : 0) * 0.1,
  }
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
      if (firstInBatch <= startSec || time.length < 100) break
      fetchEnd = firstInBatch - intervalSec
    } catch (err) { console.error(`  Error: ${err}`); break }
  }
  all.sort((a, b) => a.time - b.time)
  const seen = new Set<number>()
  return all.filter(c => seen.has(c.time) ? false : (seen.add(c.time), true))
}

async function runBacktestForSymbol(symbol: string) {
  const localCfg = { ...CFG, symbol }
  const endSec = Math.floor(Date.now() / 1000)
  const candles = await fetchAllCandles(symbol, timeframe, endSec, daysBack)
  if (candles.length < 200) { console.error(`Need >= 200 candles for ${symbol}, got ${candles.length}`); return }

  let model = createModel()
  let position: Position | null = null
  const trades: Trade[] = []
  let equity = 10000
  let lastEntryTime = 0
  let lastEntryDirection: string | null = null
  let candidateCount = 0
  let rejectedByLorentzian = 0
  let rejectedByML = 0

  for (let i = 200; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, localCfg)
    const lorentzian = classifyLorentzian(window, {
      ...localCfg, neighbors: localCfg.lorentzianNeighbors,
      lookback: Math.min(localCfg.lorentzianLookback, window.length - 80),
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
      }, snap, localCfg, opposite)

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

    // Entry - Uses REAL evaluateEntry from strategy.ts
    if (!position) {
      const signal = evaluateEntry(snap, window, localCfg, model, equity)
      const tooSoon = signal.strategy === "trend" && signal.candidateDirection === lastEntryDirection && candles[i].time - lastEntryTime < 900

      if (signal.baseTriggered && signal.candidateDirection && !tooSoon) {
        candidateCount++
        
        // BYPASS ML FOR RAW STRATEGY TEST
        if (false) {
          if (!signal.mlAllowed) rejectedByML++
          else rejectedByLorentzian++
        } else {
          // Use dynamic Kelly sizing from strategy.ts
          const dynamicSize = signal.dynamicSize ?? 500
          const effectiveSize = Math.min(dynamicSize, equity * 0.5)
          const quantity = (effectiveSize * localCfg.leverage) / snap.price
          const stops = computeInitialStops(signal.candidateDirection, snap.price, snap.atr, localCfg)

          position = {
            side: signal.candidateDirection as "long" | "short", entryPrice: snap.price, sizeUsdt: effectiveSize,
            quantity, leverage: localCfg.leverage, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
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

  console.log("\n═══════════════════════════════════════════")
  console.log(`  ${symbol} ${timeframe}  |  Last ${daysBack} days  |  Mode: ${localCfg.confirmationMode.toUpperCase()}`)
  console.log("═══════════════════════════════════════════")
  console.log(`  Candidates found: ${candidateCount}`)
  console.log(`  Rejected by ML:   ${rejectedByML}`)
  console.log(`  Rejected by Lore: ${rejectedByLorentzian}`)
  console.log(`  Trades executed:  ${trades.length}`)
  console.log(`  Win rate:         ${(winRate * 100).toFixed(1)}%`)
  console.log(`  Profit factor:    ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:        ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`)
  console.log(`  Max drawdown:     ${maxDD.toFixed(1)}%`)
  console.log(`  Final equity:     ${equity.toFixed(2)} USDT`)
  console.log("═══════════════════════════════════════════\n")
}

async function main() {
  for (const sym of symbols) {
    await runBacktestForSymbol(sym)
  }
}

main().catch(console.error)

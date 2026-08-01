// Test A: Range-only | Test B: RSI mean-reversion
// Flags: --range-only  --mean-reversion  --wider-stops  --rising-adx  --mtf-dir
import { computeSnapshot } from "./lib/indicators"
import { detectRegime, isOppositeSignal } from "./lib/strategy"
import { evaluateExit, computeInitialStops } from "./lib/exits"

const args = process.argv.slice(2)
const symbol = "BTC_USDT", timeframe = "Min5", daysBack = 30
const rangeOnly = args.includes("--range-only")
const meanRev = args.includes("--mean-reversion")
const useWiderStops = args.includes("--wider-stops")
const useRisingAdx = args.includes("--rising-adx")
const useMtfDir = args.includes("--mtf-dir")

const CFG = {
  symbol, timeframe,
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
  atrPeriod: 14, strategyMode: "auto" as const,
  adxTrendThreshold: 25, adxRangeThreshold: 20,
  bbPeriod: 20, bbStd: 2,
  slAtrMult: useWiderStops ? 3.0 : 1.5,
  tpAtrMult: useWiderStops ? 4.0 : 2.5,
  trailAtrMult: useWiderStops ? 2.0 : 1.2,
  momentumThreshold: 0.6, leverage: 5, positionSizeUsdt: 500,
  allowLong: true, allowShort: true,
}
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Position { side: "long" | "short"; entryPrice: number; sizeUsdt: number; quantity: number; leverage: number; stopLoss: number; takeProfit: number; trailingStop?: number; trailingActive: boolean; breakEvenMoved: boolean; highestPrice: number; lowestPrice: number; strategy: "trend" | "range" | "meanrev"; openedAt: number }
interface Trade { side: string; strategy: string; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; exitReason: string; openedAt: number }

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1), out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev) }
  return out
}

function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i-1], gain = Math.max(change, 0), loss = Math.max(-change, 0)
    if (i <= period) { avgGain += gain/period; avgLoss += loss/period; out[i] = 50 }
    else { avgGain = (avgGain*(period-1)+gain)/period; avgLoss = (avgLoss*(period-1)+loss)/period; out[i] = avgLoss===0 ? 100 : 100 - 100/(1+avgGain/avgLoss) }
  }
  return out
}

async function fetchAll(): Promise<Candle[]> {
  const endSec = Math.floor(Date.now() / 1000), startSec = endSec - daysBack * 86400
  const all: Candle[] = []; let fetchEnd = endSec
  while (true) {
    const fetchStart = Math.max(startSec, fetchEnd - 2000 * 300)
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${timeframe}&start=${fetchStart}&end=${fetchEnd}`
    const res = await fetch(url); const json = await res.json() as any
    if (!json.success || !json.data?.time?.length) break
    const { time, open, high, low, close, vol } = json.data
    for (let i = 0; i < time.length; i++) {
      if (time[i] >= startSec && time[i] <= endSec) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    }
    if (time[0] <= startSec || time.length < 100) break
    fetchEnd = time[0] - 300
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, arr) => i === 0 || c.time !== arr[i-1].time)
}

async function main() {
  const candles = await fetchAll()
  const mode = rangeOnly ? "RANGE-ONLY" : meanRev ? "MEAN-REVERSION" : "BASELINE"
  console.log(`${candles.length} candles | ${mode} | WiderStops=${useWiderStops} RisingADX=${useRisingAdx} MtfDir=${useMtfDir}\n`)

  const closes = candles.map(c => c.close)
  const rsiArr = rsi(closes, 14)
  const emaFast15 = ema(closes, 9 * 3)
  const emaSlow15 = ema(closes, 21 * 3)

  let position: Position | null = null
  const trades: Trade[] = []
  let equity = 10000, lastEntryTime = 0, lastEntryDirection: string | null = null
  let candidates = 0, filteredByAdx = 0, filteredByMtf = 0

  for (let i = 200; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, CFG)
    const regime = detectRegime(snap, CFG)

    // ── Exit ──
    if (position) {
      const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
      const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow
      const oppositeSignal = position.strategy !== "meanrev" && (position.side === "long" ? bearishCross : bullishCross)

      // Mean-reversion exit: close when RSI returns to neutral (50) or stop/tp hit
      let meanRevExit = false
      if (position.strategy === "meanrev") {
        const rsiNow = rsiArr[i]
        meanRevExit = (position.side === "long" && rsiNow >= 50) || (position.side === "short" && rsiNow <= 50)
      }

      const decision = evaluateExit({
        side: position.side, entryPrice: position.entryPrice, sizeUsdt: position.sizeUsdt,
        quantity: position.quantity, leverage: position.leverage, stopLoss: position.stopLoss,
        takeProfit: position.takeProfit, trailingStop: position.trailingStop,
        trailingActive: position.trailingActive, breakEvenMoved: position.breakEvenMoved,
        highestPrice: position.highestPrice, lowestPrice: position.lowestPrice,
        entryConfidence: 0.5, atrAtEntry: snap.atr, strategy: position.strategy === "meanrev" ? "range" : position.strategy,
        symbol, timeframe, id: 0, status: "open" as const,
        openedAt: new Date(position.openedAt * 1000), entryFeatures: null, rangeTarget: null, closedAt: null,
      }, snap, CFG, oppositeSignal || meanRevExit)

      const exitNow = decision.action === "close" || meanRevExit
      if (exitNow) {
        const exitPrice = meanRevExit ? snap.price : (decision.action === "close" ? snap.price : snap.price)
        const dir = position.side === "long" ? 1 : -1
        const grossPnl = (exitPrice - position.entryPrice) * dir * position.quantity
        const fees = position.entryPrice * position.quantity * TAKER_FEE + exitPrice * position.quantity * TAKER_FEE
        trades.push({
          side: position.side, strategy: position.strategy, entryPrice: position.entryPrice,
          exitPrice, pnl: grossPnl - fees, pnlPct: ((grossPnl - fees) / position.sizeUsdt) * 100,
          exitReason: meanRevExit ? "rsi-neutral" : (decision.reason ?? "unknown"), openedAt: position.openedAt,
        })
        equity += grossPnl - fees
        position = null; lastEntryDirection = null
      } else if (Object.keys(decision.updates).length > 0) {
        Object.assign(position, decision.updates)
      }
    }

    // ── Entry ──
    if (!position) {
      let strategy: "trend" | "range" | "meanrev" = "trend"
      let direction: "long" | "short" | null = null

      if (rangeOnly) {
        // Range-only: only Bollinger Band mean-reversion
        strategy = "range"
        if (snap.price <= snap.bbLower && snap.rsi <= CFG.rsiOversold && CFG.allowLong) direction = "long"
        else if (snap.price >= snap.bbUpper && snap.rsi >= CFG.rsiOverbought && CFG.allowShort) direction = "short"
      } else if (meanRev) {
        // RSI mean-reversion: enter when RSI extreme, exit when neutral
        strategy = "meanrev"
        const rsiNow = rsiArr[i]
        if (rsiNow <= 25 && CFG.allowLong) direction = "long"      // Oversold → buy
        else if (rsiNow >= 75 && CFG.allowShort) direction = "short" // Overbought → sell
      } else {
        // Baseline trend+range
        if (regime === "trend") strategy = "trend"
        else if (regime === "range") strategy = "range"
        else { continue }

        if (strategy === "trend") {
          const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
          const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow
          const alreadyBullish = snap.emaFast > snap.emaSlow && snap.prevEmaFast > snap.prevEmaSlow
          const alreadyBearish = snap.emaFast < snap.emaSlow && snap.prevEmaFast < snap.prevEmaSlow
          if ((bullishCross || alreadyBullish) && snap.rsi < CFG.rsiOverbought && CFG.allowLong) direction = "long"
          else if ((bearishCross || alreadyBearish) && snap.rsi > CFG.rsiOversold && CFG.allowShort) direction = "short"
        } else {
          if (snap.price <= snap.bbLower && snap.rsi <= CFG.rsiOversold && CFG.allowLong) direction = "long"
          else if (snap.price >= snap.bbUpper && snap.rsi >= CFG.rsiOverbought && CFG.allowShort) direction = "short"
        }
      }

      if (direction) {
        candidates++

        // Rising ADX filter (trend only)
        if (useRisingAdx && strategy === "trend") {
          const snapPrev = computeSnapshot(candles.slice(0, i - 5), CFG)
          if (snap.adx <= snapPrev.adx) { filteredByAdx++; continue }
        }

        // MTF direction filter
        if (useMtfDir && (strategy === "trend" || strategy === "meanrev")) {
          const mtfBullish = emaFast15[i] > emaSlow15[i]
          if ((direction === "long" && !mtfBullish) || (direction === "short" && mtfBullish)) { filteredByMtf++; continue }
        }

        const tooSoon = strategy !== "range" && direction === lastEntryDirection && candles[i].time - lastEntryTime < 900
        if (tooSoon) continue

        const quantity = (CFG.positionSizeUsdt * CFG.leverage) / snap.price
        const stops = computeInitialStops(direction, snap.price, snap.atr, CFG)
        // Tighter stops for mean-reversion (quick trades)
        const sl = strategy === "meanrev" ? (direction === "long" ? snap.price - snap.atr * 1.0 : snap.price + snap.atr * 1.0) : stops.stopLoss
        const tp = strategy === "meanrev" ? (direction === "long" ? snap.price + snap.atr * 1.5 : snap.price - snap.atr * 1.5) : stops.takeProfit

        position = {
          side: direction, entryPrice: snap.price, sizeUsdt: CFG.positionSizeUsdt,
          quantity, leverage: CFG.leverage, stopLoss: sl, takeProfit: tp,
          trailingActive: false, breakEvenMoved: false, highestPrice: snap.price,
          lowestPrice: snap.price, strategy, openedAt: candles[i].time,
        }
        lastEntryTime = candles[i].time
        lastEntryDirection = direction
      }
    }
  }

  if (position) {
    const lastPrice = candles[candles.length - 1].close
    const dir = position.side === "long" ? 1 : -1
    const grossPnl = (lastPrice - position.entryPrice) * dir * position.quantity
    const fees = position.entryPrice * position.quantity * TAKER_FEE + lastPrice * position.quantity * TAKER_FEE
    trades.push({
      side: position.side, strategy: position.strategy, entryPrice: position.entryPrice,
      exitPrice: lastPrice, pnl: grossPnl - fees, pnlPct: ((grossPnl - fees) / position.sizeUsdt) * 100,
      exitReason: "eob", openedAt: position.openedAt,
    })
    equity += grossPnl - fees
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0)
  const profitFactor = grossLoss === 0 ? Infinity : wins.reduce((s, t) => s + t.pnl, 0) / grossLoss
  const winRate = trades.length > 0 ? wins.length / trades.length : 0

  const byStrategy: Record<string, Trade[]> = {}
  for (const t of trades) {
    const k = t.strategy
    if (!byStrategy[k]) byStrategy[k] = []
    byStrategy[k].push(t)
  }

  console.log("═══════════════════════════════════════════")
  console.log(`  ${mode}  ${useWiderStops ? "WiderStops" : ""}  ${useRisingAdx ? "RisingADX" : ""}  ${useMtfDir ? "MtfDir" : ""}`)
  console.log("═══════════════════════════════════════════")
  console.log(`  Candidates:     ${candidates}`)
  if (useRisingAdx) console.log(`  ADX filtered:   ${filteredByAdx}`)
  if (useMtfDir) console.log(`  MTF filtered:   ${filteredByMtf}`)
  console.log(`  Trades:         ${trades.length}`)
  for (const [s, ts] of Object.entries(byStrategy)) {
    const w = ts.filter(t => t.pnl > 0)
    console.log(`    ${s.padEnd(8)} ${ts.length.toString().padStart(3)} trades  WR ${ts.length>0?(w.length/ts.length*100).toFixed(0):"0"}%  PnL ${ts.reduce((a,t)=>a+t.pnl,0).toFixed(2)}`)
  }
  console.log(`  Win rate:       ${(winRate*100).toFixed(1)}%`)
  console.log(`  Profit factor:  ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:      ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`)
  console.log(`  Avg win:        +${(wins.reduce((s,t)=>s+t.pnl,0)/Math.max(1,wins.length)).toFixed(2)}`)
  console.log(`  Avg loss:       ${(losses.reduce((s,t)=>s+t.pnl,0)/Math.max(1,losses.length)).toFixed(2)}`)
  console.log(`  Max win:        ${wins.length>0?Math.max(...wins.map(t=>t.pnl)).toFixed(2):"—"}`)
  console.log(`  Max loss:       ${losses.length>0?Math.min(...losses.map(t=>t.pnl)).toFixed(2):"—"}`)
  
  const eqCurve: number[] = [10000]; let running = 10000
  for (const t of trades) { running += t.pnl; eqCurve.push(running) }
  let peak = 10000, maxDD = 0
  for (const e of eqCurve) { if (e > peak) peak = e; const dd = (peak-e)/peak*100; if (dd > maxDD) maxDD = dd }
  
  console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%`)
  console.log(`  Final equity:   ${equity.toFixed(2)}`)
  console.log(`  Return:         ${((equity-10000)/100).toFixed(1)}%`)
  console.log("═══════════════════════════════════════════\n")
}

main().catch(console.error)

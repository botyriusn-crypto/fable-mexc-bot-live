// Minimal backtester — strategy signals only, no ML/Lorentzian gates
import { computeSnapshot, type FeatureVector } from "./lib/indicators"
import { detectRegime, isOppositeSignal } from "./lib/strategy"
import { evaluateExit, computeInitialStops } from "./lib/exits"

const symbol = "BTC_USDT", timeframe = "Min5", daysBack = 30
const CFG = {
  symbol, timeframe,
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
  atrPeriod: 14, strategyMode: "auto" as const,
  adxTrendThreshold: 25, adxRangeThreshold: 20,
  bbPeriod: 20, bbStd: 2, slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2,
  momentumThreshold: 0.6, leverage: 5, positionSizeUsdt: 500,
  allowLong: true, allowShort: true,
}
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Position { side: "long" | "short"; entryPrice: number; sizeUsdt: number; quantity: number; leverage: number; stopLoss: number; takeProfit: number; trailingStop?: number; trailingActive: boolean; breakEvenMoved: boolean; highestPrice: number; lowestPrice: number; strategy: "trend" | "range"; openedAt: number }
interface Trade { side: string; strategy: string; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; exitReason: string; openedAt: number; closedAt: number }

async function fetchAll(): Promise<Candle[]> {
  const endSec = Math.floor(Date.now() / 1000)
  const startSec = endSec - daysBack * 86400
  const all: Candle[] = []
  let fetchEnd = endSec
  while (true) {
    const fetchStart = Math.max(startSec, fetchEnd - 2000 * 300)
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${timeframe}&start=${fetchStart}&end=${fetchEnd}`
    const res = await fetch(url)
    const json = await res.json() as any
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
  console.log(`${candles.length} candles\n`)
  
  let position: Position | null = null
  const trades: Trade[] = []
  let equity = 10000
  let lastEntryTime = 0
  let lastEntryDirection: string | null = null
  let candidates = 0, rangeTrades = 0, trendTrades = 0

  for (let i = 200; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, CFG)
    const regime = detectRegime(snap, CFG)
    
    // Exit
    if (position) {
      const opposite = position.strategy === "trend" && (() => {
        const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
        const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow
        return position.side === "long" ? bearishCross : bullishCross
      })()
      const decision = evaluateExit({
        side: position.side, entryPrice: position.entryPrice, sizeUsdt: position.sizeUsdt,
        quantity: position.quantity, leverage: position.leverage, stopLoss: position.stopLoss,
        takeProfit: position.takeProfit, trailingStop: position.trailingStop,
        trailingActive: position.trailingActive, breakEvenMoved: position.breakEvenMoved,
        highestPrice: position.highestPrice, lowestPrice: position.lowestPrice,
        entryConfidence: 0.5, atrAtEntry: snap.atr, strategy: position.strategy,
        symbol, timeframe, id: 0, status: "open" as const,
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
        position = null
        lastEntryDirection = null
      } else if (Object.keys(decision.updates).length > 0) {
        Object.assign(position, decision.updates)
      }
    }

    // Entry — strategy only, no ML/Lorentzian gates
    if (!position) {
      let strategy: "trend" | "range" | null = null
      if (regime === "trend") strategy = "trend"
      else if (regime === "range") strategy = "range"

      if (strategy) {
        let direction: "long" | "short" | null = null
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

        if (direction) {
          candidates++
          const tooSoon = strategy === "trend" && direction === lastEntryDirection && candles[i].time - lastEntryTime < 900
          if (!tooSoon) {
            const quantity = (CFG.positionSizeUsdt * CFG.leverage) / snap.price
            const stops = computeInitialStops(direction, snap.price, snap.atr, CFG)
            position = {
              side: direction, entryPrice: snap.price, sizeUsdt: CFG.positionSizeUsdt,
              quantity, leverage: CFG.leverage, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
              trailingActive: false, breakEvenMoved: false, highestPrice: snap.price,
              lowestPrice: snap.price, strategy, openedAt: candles[i].time,
            }
            lastEntryTime = candles[i].time
            lastEntryDirection = direction
            if (strategy === "trend") trendTrades++; else rangeTrades++
          }
        }
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
      exitReason: "eob", openedAt: position.openedAt, closedAt: candles[candles.length - 1].time,
    })
    equity += grossPnl - fees
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0)
  const profitFactor = grossLoss === 0 ? Infinity : wins.reduce((s, t) => s + t.pnl, 0) / grossLoss
  const winRate = trades.length > 0 ? wins.length / trades.length : 0

  console.log("═══════════════════════════════════════════")
  console.log(`  NAKED STRATEGY (no ML/Lorentzian gates)`)
  console.log(`  ${symbol} ${timeframe} | Last ${daysBack} days`)
  console.log("═══════════════════════════════════════════")
  console.log(`  Candidates:    ${candidates}`)
  console.log(`  Trades:        ${trades.length} (trend: ${trendTrades}, range: ${rangeTrades})`)
  console.log(`  Win rate:      ${(winRate * 100).toFixed(1)}%`)
  console.log(`  Profit factor: ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:     ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`)
  console.log(`  Avg win:       +${(wins.reduce((s,t) => s+t.pnl,0)/Math.max(1,wins.length)).toFixed(2)}`)
  console.log(`  Avg loss:      ${(losses.reduce((s,t) => s+t.pnl,0)/Math.max(1,losses.length)).toFixed(2)}`)
  console.log(`  Final equity:  ${equity.toFixed(2)}`)
  console.log(`  Return:        ${((equity-10000)/100).toFixed(1)}%`)
  console.log("═══════════════════════════════════════════")

  if (trades.length <= 30) {
    console.log("\nAll trades:")
    for (const t of trades) {
      const d = new Date(t.openedAt * 1000).toISOString().split("T")[0]
      console.log(`  ${d} ${t.side.toUpperCase().padEnd(5)} ${t.strategy.padEnd(5)} | ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)} | ${t.pnl>=0?"+":""}${t.pnl.toFixed(2)} | ${t.exitReason}`)
    }
  }
}

main().catch(console.error)

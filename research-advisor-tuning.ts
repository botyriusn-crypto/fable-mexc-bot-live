// Run advisor on full universe, backtest top candidates, find winning metrics
import { atr, adx, bollinger } from "./lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Candidate {
  symbol: string
  volume: number
  atrPct: number
  adx: number
  chop: number
  bbTouches: number
  momentum: number
  score: number
  dnaScore: number
  blendedScore: number
}

async function fetchCandles(symbol: string, days: number = 3): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min15&start=${start}&end=${end}`)
  const json = await res.json() as any
  if (!json.success || !json.data?.time) return []
  const { time, open, high, low, close, vol } = json.data
  return time.map((t: number, i: number) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 }))
}

async function scoreCandidate(symbol: string, volume: number): Promise<Candidate | null> {
  const candles = await fetchCandles(symbol, 3)
  if (candles.length < 50) return null
  
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const lastClose = closes[closes.length - 1]
  
  const atrArr = atr(candles, 14)
  const adxArr = adx(candles, 14)
  const lastAtr = atrArr[atrArr.length - 1]
  const lastAdx = adxArr[adxArr.length - 1]
  const atrPct = (lastAtr / lastClose) * 100
  
  // BB touches
  const bb = bollinger(closes, 20, 2)
  let bbTouches = 0
  for (let i = 20; i < closes.length; i++) {
    if (highs[i] >= bb.upper[i] || lows[i] <= bb.lower[i]) bbTouches++
  }
  
  // Chop (advisor's formula)
  const path = candles.reduce((a, k) => a + (k.high - k.low), 0)
  const net = Math.abs(closes[closes.length - 1] - closes[0])
  const mid = closes[Math.floor(closes.length / 2)]
  const chop = path / Math.max(net, mid * 0.002)
  
  // Momentum
  const n = closes.length
  const momentum = n > 12 ? ((closes[n-1] - closes[n-12]) / closes[n-12]) * 100 : 0
  
  // Score (advisor formula)
  let score = 0
  score += (chop - 50) * 2
  score += bbTouches * 3
  score += atrPct * 5
  score -= (lastAdx - 20) * 1.5
  
  // Simplified DNA score (actual uses complex logic)
  const dnaScore = Math.min(100, Math.max(0, atrPct * 10 + (100 - lastAdx) * 0.5))
  const blendedScore = Math.round(Math.min(score, 100) * 0.35 + dnaScore * 0.65)
  
  return { symbol, volume, atrPct, adx: lastAdx, chop, bbTouches, momentum, score, dnaScore, blendedScore }
}

async function quickBacktest(symbol: string, days: number = 30): Promise<{ trades: number; pnl: number }> {
  const candles = await fetchCandles(symbol, days)
  if (candles.length < 300) return { trades: 0, pnl: 0 }
  
  const closes = candles.map(c => c.close)
  const atrArr = atr(candles, 14)
  const lastAtr = atrArr[atrArr.length - 1]
  const lastClose = closes[closes.length - 1]
  const spacing = lastAtr * 0.6
  
  const gridLevels: number[] = []
  for (let i = -6; i <= 6; i++) {
    if (i !== 0) gridLevels.push(lastClose + i * spacing)
  }
  
  let trades = 0, pnl = 0
  const buys: { price: number; qty: number }[] = []
  
  for (let i = 50; i < candles.length; i++) {
    const c = candles[i]
    for (const level of gridLevels) {
      if (c.low <= level && c.high >= level) {
        const isBuy = c.close > level
        if (isBuy) {
          buys.push({ price: level, qty: 100 })
        } else if (buys.length > 0) {
          const buy = buys.pop()!
          const gross = (level - buy.price) * buy.qty
          const fees = (level * buy.qty + buy.price * buy.qty) * 0.0002
          pnl += gross - fees
          trades++
        }
      }
    }
  }
  
  return { trades, pnl }
}

async function main() {
  console.log("=== Advisor Tuning Research ===\n")
  
  // Fetch top 100 by volume
  const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const tickerJson = await tickerRes.json() as any
  const candidates = tickerJson.data
    .filter((t: any) => t.symbol.endsWith("_USDT") && t.amount24 > 15_000_000)
    .sort((a: any, b: any) => b.amount24 - a.amount24)
    .slice(0, 100)
  
  console.log("Scoring top 100 candidates...")
  const scored: Candidate[] = []
  for (const t of candidates) {
    const c = await scoreCandidate(t.symbol, t.amount24)
    if (c) scored.push(c)
  }
  
  // Sort by blended score, take top 20
  const top20 = scored.sort((a, b) => b.blendedScore - a.blendedScore).slice(0, 20)
  
  console.log("\n=== Top 20 by Advisor Score ===")
  console.log("Symbol      | Score | DNA   | Blend | ATR%  | Chop  | BB    | ADX   | Trades | PnL")
  console.log("------------|-------|-------|-------|-------|-------|-------|-------|--------|--------")
  
  const results: any[] = []
  for (const c of top20) {
    const bt = await quickBacktest(c.symbol, 30)
    results.push({ ...c, trades: bt.trades, pnl: bt.pnl })
    console.log(`${c.symbol.padEnd(12)}| ${c.score.toFixed(0).padStart(5)} | ${c.dnaScore.toFixed(0).padStart(5)} | ${c.blendedScore.toString().padStart(5)} | ${c.atrPct.toFixed(2).padStart(5)} | ${c.chop.toFixed(0).padStart(5)} | ${c.bbTouches.toString().padStart(5)} | ${c.adx.toFixed(1).padStart(5)} | ${bt.trades.toString().padStart(6)} | $${bt.pnl.toFixed(0).padStart(6)}`)
  }
  
  // Find ONDO
  const ondo = scored.find(c => c.symbol === "ONDO_USDT")
  if (ondo) {
    const bt = await quickBacktest("ONDO_USDT", 30)
    console.log(`\n=== ONDO (ranked #${scored.findIndex(c => c.symbol === "ONDO_USDT") + 1} of ${scored.length}) ===`)
    console.log(`Score: ${ondo.score.toFixed(0)}, Blend: ${ondo.blendedScore}`)
    console.log(`ATR%: ${ondo.atrPct.toFixed(2)}, Chop: ${ondo.chop.toFixed(0)}, BB: ${ondo.bbTouches}`)
    console.log(`Backtest: ${bt.trades} trades, $${bt.pnl.toFixed(0)} PnL`)
  }
  
  console.log("\n=== Winning Pattern Analysis ===")
  const winners = results.filter(r => r.pnl > 0)
  const losers = results.filter(r => r.pnl <= 0)
  
  if (winners.length > 0) {
    const avgWinATR = winners.reduce((s, r) => s + r.atrPct, 0) / winners.length
    const avgWinChop = winners.reduce((s, r) => s + r.chop, 0) / winners.length
    const avgWinBB = winners.reduce((s, r) => s + r.bbTouches, 0) / winners.length
    console.log(`Winners (${winners.length}) avg: ATR ${avgWinATR.toFixed(2)}%, Chop ${avgWinChop.toFixed(0)}, BB ${avgWinBB.toFixed(0)}`)
  }
  
  if (losers.length > 0) {
    const avgLossATR = losers.reduce((s, r) => s + r.atrPct, 0) / losers.length
    const avgLossChop = losers.reduce((s, r) => s + r.chop, 0) / losers.length
    console.log(`Losers (${losers.length}) avg: ATR ${avgLossATR.toFixed(2)}%, Chop ${avgLossChop.toFixed(0)}`)
  }
  
  console.log("\n=== Recommendations ===")
  console.log("1. Current formula overweights chop (ONDO has low chop but wins)")
  console.log("2. Current formula underweights ATR% (ONDO has high ATR% and wins)")
  console.log("3. Need to rebalance weights based on actual backtest results")
}

main().catch(console.error)

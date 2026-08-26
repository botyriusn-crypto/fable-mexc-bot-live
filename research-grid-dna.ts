// Analyze ONDO characteristics vs AI Advisor gates
import { atr, adx, bollinger, ema } from "./lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchCandles(symbol: string, days: number = 7): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min15&start=${start}&end=${end}`)
  const json = await res.json() as any
  if (!json.success || !json.data?.time) throw new Error("Failed to fetch klines")
  
  const { time, open, high, low, close, vol } = json.data
  return time.map((t: number, i: number) => ({
    time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0
  }))
}

function calcChop(candles: Candle[], period: number = 14): number {
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  
  let sumTR = 0, sumDiff = 0
  for (let i = period; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    sumTR += tr
    sumDiff += Math.abs(closes[i] - closes[i-period])
  }
  
  const n = closes.length - period
  if (n <= 0 || sumTR === 0) return 50
  return (Math.log10(sumDiff / sumTR) / Math.log10(n)) * 100
}

function countBBTouches(candles: Candle[], period: number = 20): number {
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const bb = bollinger(closes, period, 2)
  
  let touches = 0
  for (let i = period; i < closes.length; i++) {
    if (highs[i] >= bb.upper[i] || lows[i] <= bb.lower[i]) touches++
  }
  return touches
}

function calcMomentum(candles: Candle[], period: number = 12): number {
  const closes = candles.map(c => c.close)
  const n = closes.length
  if (n < period + 1) return 0
  return ((closes[n-1] - closes[n-1-period]) / closes[n-1-period]) * 100
}

async function analyzeSymbol(symbol: string, label: string) {
  console.log(`\n=== ${symbol} (${label}) ===`)
  
  const candles = await fetchCandles(symbol, 7)
  const closes = candles.map(c => c.close)
  const lastClose = closes[closes.length - 1]
  
  const atrArr = atr(candles, 14)
  const adxArr = adx(candles, 14)
  const lastAtr = atrArr[atrArr.length - 1]
  const lastAdx = adxArr[adxArr.length - 1]
  const atrPct = (lastAtr / lastClose) * 100
  
  const chop = calcChop(candles, 14)
  const bbTouches = countBBTouches(candles, 20)
  const momentum3h = calcMomentum(candles, 12)
  
  // Advisor scoring formula (from ai-grid-advisor.ts line 178-182)
  let score = 0
  score += (chop - 50) * 2
  score += bbTouches * 3
  score += atrPct * 5
  score -= (lastAdx - 20) * 1.5
  
  console.log(`ATR%: ${atrPct.toFixed(2)}% (gate: > 0.30% for fee clearance)`)
  console.log(`ADX: ${lastAdx.toFixed(1)} (lower = more ranging, ideal < 25)`)
  console.log(`Chop: ${chop.toFixed(1)} (higher = more choppy, ideal > 50)`)
  console.log(`BB Touches: ${bbTouches} (higher = better range)`)
  console.log(`3h Momentum: ${momentum3h.toFixed(2)}% (gate: |x| < 2.5%)`)
  console.log(`\nScore breakdown:`)
  console.log(`  Chop contribution: ${(chop - 50) * 2}`)
  console.log(`  BB contribution: ${bbTouches * 3}`)
  console.log(`  ATR contribution: ${atrPct * 5}`)
  console.log(`  ADX penalty: ${-(lastAdx - 20) * 1.5}`)
  console.log(`  TOTAL: ${Math.min(score, 100).toFixed(1)}`)
  
  const feeGate = atrPct / 10 < 0.03
  const momentumGate = Math.abs(momentum3h) > 2.5
  
  console.log(`\nGate checks:`)
  console.log(`  Fee gate (atrPct/10 < 0.03%): ${feeGate ? "❌ REJECT" : "✅ PASS"}`)
  console.log(`  Momentum gate (|3h| > 2.5%): ${momentumGate ? "❌ REJECT" : "✅ PASS"}`)
  console.log(`  Would be scored: ${!feeGate && !momentumGate ? "YES" : "NO"}`)
  
  return { symbol, atrPct, adx: lastAdx, chop, bbTouches, momentum3h, score, feeGate, momentumGate }
}

async function main() {
  console.log("=== Grid DNA Analysis: ONDO vs Controls ===\n")
  console.log("Volume check: ONDO $57.6M (gate: > $15M) ✅")
  
  const ondo = await analyzeSymbol("ONDO_USDT", "WINNER - $6913/30d")
  const btc = await analyzeSymbol("BTC_USDT", "CONTROL - High vol trend")
  const link = await analyzeSymbol("LINK_USDT", "CONTROL - Medium vol")
  
  console.log("\n=== Comparison Table ===")
  console.log("Symbol   | ATR%  | ADX   | Chop  | BB    | Mom%  | Score | Gates")
  console.log("---------|-------|-------|-------|-------|-------|-------|------")
  for (const r of [ondo, btc, link]) {
    const gates = `${r.feeGate ? "❌F" : "✅F"} ${r.momentumGate ? "❌M" : "✅M"}`
    console.log(`${r.symbol.padEnd(9)}| ${r.atrPct.toFixed(2).padStart(5)} | ${r.adx.toFixed(1).padStart(5)} | ${r.chop.toFixed(1).padStart(5)} | ${r.bbTouches.toString().padStart(5)} | ${r.momentum3h.toFixed(2).padStart(5)} | ${r.score.toFixed(0).padStart(5)} | ${gates}`)
  }
  
  console.log("\n=== ONDO's Winning Formula ===")
  console.log(`✓ ATR%: ${ondo.atrPct.toFixed(2)}% — perfect grid fuel (0.4-1.0% ideal)`)
  console.log(`✓ ADX: ${ondo.adx.toFixed(1)} — ranging regime (lower = better for grids)`)
  console.log(`✓ Chop: ${ondo.chop.toFixed(1)} — oscillation quality`)
  console.log(`✓ BB Touches: ${ondo.bbTouches} — range boundary crossings`)
  console.log(`✓ Momentum: ${ondo.momentum3h.toFixed(2)}% — no directional bias`)
}

main().catch(console.error)

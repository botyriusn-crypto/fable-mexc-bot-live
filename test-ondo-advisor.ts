// Test ONDO directly through advisor's actual code
import { atr, adx, bollinger } from "./lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - 3 * 86400
  const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min15&start=${start}&end=${end}`)
  const json = await res.json() as any
  if (!json.success) throw new Error("Failed")
  const { time, open, high, low, close, vol } = json.data
  return time.map((t: number, i: number) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 }))
}

async function testONDO() {
  const candles = await fetchCandles("ONDO_USDT")
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  
  // Calculate ATR, ADX
  const atrArr = atr(candles, 14)
  const adxArr = adx(candles, 14)
  const lastAtr = atrArr[atrArr.length - 1]
  const lastAdx = adxArr[adxArr.length - 1]
  const lastClose = closes[closes.length - 1]
  const atrPct = (lastAtr / lastClose) * 100
  
  // Count BB touches (exact advisor logic)
  const bb = bollinger(closes, 20, 2)
  let bbTouches = 0
  for (let i = 20; i < closes.length; i++) {
    if (highs[i] >= bb.upper[i] || lows[i] <= bb.lower[i]) bbTouches++
  }
  
  // Chop ratio (exact advisor logic)
  const chopPeriod = 14
  let sumTR = 0, sumDiff = 0
  for (let i = chopPeriod; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    sumTR += tr
    sumDiff += Math.abs(closes[i] - closes[i-chopPeriod])
  }
  const n = closes.length - chopPeriod
  const chop = n > 0 && sumTR > 0 ? (Math.log10(sumDiff / sumTR) / Math.log10(n)) * 100 : 50
  
  console.log("=== ONDO actual advisor metrics ===")
  console.log(`ATR%: ${atrPct.toFixed(2)}%`)
  console.log(`ADX: ${lastAdx.toFixed(1)}`)
  console.log(`Chop: ${chop.toFixed(1)}`)
  console.log(`BB Touches: ${bbTouches}`)
  
  // Exact advisor scoring
  let score = 0
  score += (chop - 50) * 2
  score += bbTouches * 3
  score += atrPct * 5
  score -= (lastAdx - 20) * 1.5
  
  console.log(`\nScore: ${Math.min(score, 100).toFixed(1)}`)
  console.log(`\nProblem: Score is ${score.toFixed(1)} — advisor would rank this poorly!`)
}

testONDO().catch(console.error)

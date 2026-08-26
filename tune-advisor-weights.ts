// Test alternative scoring weights to find better correlation with PnL
import { atr, adx, bollinger } from "./lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchCandles(symbol: string, days: number = 3): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min15&start=${start}&end=${end}`)
  const json = await res.json() as any
  if (!json.success || !json.data?.time) return []
  const { time, open, high, low, close, vol } = json.data
  return time.map((t: number, i: number) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 }))
}

async function scoreWithWeights(symbol: string, weights: { chop: number; bb: number; atr: number; adx: number }): Promise<number> {
  const candles = await fetchCandles(symbol, 3)
  if (candles.length < 50) return -999
  
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const lastClose = closes[closes.length - 1]
  
  const atrArr = atr(candles, 14)
  const adxArr = adx(candles, 14)
  const lastAtr = atrArr[atrArr.length - 1]
  const lastAdx = adxArr[adxArr.length - 1]
  const atrPct = (lastAtr / lastClose) * 100
  
  const bb = bollinger(closes, 20, 2)
  let bbTouches = 0
  for (let i = 20; i < closes.length; i++) {
    if (highs[i] >= bb.upper[i] || lows[i] <= bb.lower[i]) bbTouches++
  }
  
  const path = candles.reduce((a, k) => a + (k.high - k.low), 0)
  const net = Math.abs(closes[closes.length - 1] - closes[0])
  const mid = closes[Math.floor(closes.length / 2)]
  const chop = path / Math.max(net, mid * 0.002)
  
  let score = 0
  score += (chop - 50) * weights.chop
  score += bbTouches * weights.bb
  score += atrPct * weights.atr
  score -= (lastAdx - 20) * weights.adx
  
  return Math.min(score, 100)
}

async function main() {
  const symbols = [
    { symbol: "XMR_USDT", pnl: 18388 },
    { symbol: "SNDKSTOCK_USDT", pnl: 20518 },
    { symbol: "MUSTOCK_USDT", pnl: 2179 },
    { symbol: "TAO_USDT", pnl: 7847 },
    { symbol: "NEAR_USDT", pnl: 145 },
    { symbol: "UNI_USDT", pnl: 116 },
    { symbol: "ATOM_USDT", pnl: 47 },
    { symbol: "SPX500_USDT", pnl: -47486 },
    { symbol: "SKHYSTOCK_USDT", pnl: -2532 },
    { symbol: "BTW_USDT", pnl: -29 }
  ]
  
  console.log("=== Testing Alternative Weight Configurations ===\n")
  
  const configs = [
    { name: "Current", chop: 2, bb: 3, atr: 5, adx: 1.5 },
    { name: "ATR-heavy", chop: 2, bb: 3, atr: 8, adx: 1.5 },
    { name: "Chop-heavy", chop: 3, bb: 3, atr: 5, adx: 1.5 },
    { name: "Balanced", chop: 2.5, bb: 3, atr: 6, adx: 1.5 }
  ]
  
  for (const cfg of configs) {
    console.log(`\n--- ${cfg.name} (chop:${cfg.chop} bb:${cfg.bb} atr:${cfg.atr} adx:${cfg.adx}) ---`)
    
    const scored = []
    for (const s of symbols) {
      const score = await scoreWithWeights(s.symbol, cfg)
      scored.push({ ...s, score })
    }
    
    scored.sort((a, b) => b.score - a.score)
    
    console.log("Symbol            | Score | PnL")
    console.log("------------------|-------|--------")
    for (const s of scored.slice(0, 5)) {
      console.log(`${s.symbol.padEnd(18)}| ${s.score.toFixed(0).padStart(5)} | $${s.pnl.toString().padStart(6)}`)
    }
    
    // Correlation: rank order vs PnL order
    const pnlRank = [...scored].sort((a, b) => b.pnl - a.pnl)
    let rankCorrelation = 0
    for (let i = 0; i < scored.length; i++) {
      const scoreRank = scored.findIndex(s => s.symbol === pnlRank[i].symbol)
      rankCorrelation += Math.abs(i - scoreRank)
    }
    console.log(`Rank correlation: ${rankCorrelation} (lower = better alignment with PnL)`)
  }
}

main().catch(console.error)

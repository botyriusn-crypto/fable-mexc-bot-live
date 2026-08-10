import { NextResponse } from "next/server"
import { ema, atr, adx, bollinger } from "@/lib/indicators"
import { db } from "@/lib/db"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"
import { botLogs } from "@/lib/db/schema"
import { livePrices } from "@/lib/mexc/ws"
import type { Candle } from "@/lib/mexc/public"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Helper to calculate Choppiness Index (CHOP)
// High values (>61.8) indicate choppy/ranging markets (perfect for grids).
// Low values (<38.2) indicate trending markets (bad for grids).
function calcChop(candles: Candle[], period: number = 14): number {
  if (candles.length < period) return 50
  const atrArr = atr(candles, period)
  const sumAtr = atrArr.slice(-period).reduce((a, b) => a + b, 0)
  
  const highs = candles.slice(-period).map(c => c.high)
  const lows = candles.slice(-period).map(c => c.low)
  const maxHigh = Math.max(...highs)
  const minLow = Math.min(...lows)
  const range = maxHigh - minLow
  
  if (range <= 0 || sumAtr <= 0) return 50
  return 100 * Math.log10(sumAtr / range) / Math.log10(period)
}

export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError
  try {
    // 1. Fetch top MEXC pairs by volume
    const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker", { cache: "no-store" })
    const tickerJson = await tickerRes.json() as any
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
    
    const candidates = (tickerJson.data as any[])
      .filter(t => t.symbol.endsWith("_USDT") && !t.symbol.includes("STOCK") && !t.symbol.includes("3L") && !t.symbol.includes("3S"))
      .filter(t => t.amount24 > 50000000) // > $50M volume
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 30) // Deep scan top 30

    const scoredMarkets: any[] = []

    // 2. Compute Oscillation Quality Score (OQS)
    for (const t of candidates) {
      try {
        const end = Math.floor(Date.now() / 1000)
        const start = end - (3 * 24 * 3600) // 3 days of 15m candles
        const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min15&start=${start}&end=${end}`, { cache: "no-store" })
        const klineJson = await klineRes.json() as any
        if (!klineJson.success || !klineJson.data?.time?.length) continue
        
        const { time, open, high, low, close, vol } = klineJson.data
        const candles: Candle[] = []
        for (let i = 0; i < time.length; i++) {
          candles.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
        }
        if (candles.length < 50) continue
        
        const closes = candles.map(c => c.close)
        const lastClose = closes[closes.length - 1]
        const atrArr = atr(candles, 14)
        const adxArr = adx(candles, 14)
        const lastAtr = atrArr[atrArr.length - 1]
        const lastAdx = adxArr[adxArr.length - 1]
        const atrPct = (lastAtr / lastClose) * 100
        
        // Hard filters
        if (atrPct < 0.8) continue // Too dead
        if (lastAdx > 35) continue // Too trending
        
        // Calculate Choppiness Index
        const chop = calcChop(candles, 14)
        
        // Calculate BB Touches (Oscillation frequency)
        let bbTouches = 0
        const lookback = Math.min(50, candles.length)
        for (let i = candles.length - lookback; i < candles.length; i++) {
          const slice = closes.slice(Math.max(0, i - 20), i + 1)
          if (slice.length < 20) continue
          const bb = bollinger(slice, 20, 2)
          if (candles[i].low <= bb.lower || candles[i].high >= bb.upper) {
            bbTouches++
          }
        }
        
        // Momentum check (don't catch falling knives)
        const momentum3h = closes.length >= 13 ? ((closes[closes.length - 1] - closes[closes.length - 13]) / closes[closes.length - 13]) * 100 : 0 // 13 * 15m = ~3.25h
        if (momentum3h < -3.0) continue 
        
        // OQS Scoring
        // High CHOP (>60) is great. High BB touches is great. High ATR% is great. Low ADX is great.
        let score = 0
        score += (chop - 50) * 2 // Reward choppiness
        score += bbTouches * 3   // Reward oscillation
        score += atrPct * 5      // Reward volatility
        score -= (lastAdx - 20) * 1.5 // Penalize trend
        
        scoredMarkets.push({
          symbol: t.symbol,
          volumeUsdt: Math.round(t.amount24),
          atrPct: parseFloat(atrPct.toFixed(2)),
          adx: parseFloat(lastAdx.toFixed(1)),
          chop: parseFloat(chop.toFixed(1)),
          bbTouches,
          momentum3h: parseFloat(momentum3h.toFixed(2)),
          score: Math.round(score)
        })
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100))
      } catch (err) { continue }
    }

    // 3. Sort by OQS and pick top 3
    const topPicks = scoredMarkets.sort((a, b) => b.score - a.score).slice(0, 3)
    
    // 4. Generate optimal parameters mathematically based on the metrics
    const recommendations = topPicks.map(m => {
      // Levels: More levels for high chop, fewer for high ATR
      let levels = 8
      if (m.chop > 65) levels = 10
      if (m.atrPct > 2.5) levels = 6
      
      // ATR Mult: Tighter for high chop, wider for trending/low chop
      let atrMult = 1.5
      if (m.chop > 65) atrMult = 1.2
      if (m.chop < 55) atrMult = 2.0
      
      // Leverage: Conservative for high vol
      let leverage = 3
      if (m.atrPct < 1.5) leverage = 5
      
      return {
        symbol: m.symbol,
        reason: `OQS: ${m.score} | CHOP: ${m.chop} | BB Touches: ${m.bbTouches} | ATR: ${m.atrPct}% | ADX: ${m.adx}`,
        levels,
        atrMult,
        leverage,
        budgetPct: 10
      }
    })
    
    // Log picks to DB
    for (const rec of recommendations) {
      const entryPrice = livePrices[rec.symbol]
      if (entryPrice) {
        await db.insert(botLogs).values({
          level: "ai_pick",
          message: `AI Pick (OQS): ${rec.symbol}`,
          details: { symbol: rec.symbol, entryPrice, settings: rec }
        })
      }
    }
    
    return NextResponse.json({ success: true, recommendations })

  } catch (err: any) {
    console.error("AI Advisor Error:", err)
    return NextResponse.json({ success: false, error: err?.message || "AI scan failed" }, { status: 500 })
  }
}

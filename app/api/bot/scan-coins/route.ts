import { NextResponse } from "next/server"
import { ema, atr, adx } from "@/lib/indicators"
import type { Candle } from "@/lib/mexc/public"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60 // Allow up to 60s for scanning

interface ScanResult {
  symbol: string
  score: number
  atrPct: number
  adx: number
  volumeUsdt: number
  reason: string
}

export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError
  try {
    // 1. Fetch all MEXC contract tickers to find high-volume, non-extreme movers
    const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
    const tickerJson = await tickerRes.json() as any
    
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
    
    const allTickers = tickerJson.data as any[]
    
    // Filter for USDT pairs, high volume (> $50M), and not extreme 24h pumps/dumps (< 12%)
    const candidates = allTickers
      .filter(t => t.symbol.endsWith("_USDT"))
      .filter(t => t.amount24 > 50000000) // > $50M volume
      .filter(t => Math.abs(t.riseFallRate) < 0.12) // Less than 12% move in 24h
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 25) // Take top 25 by volume to deep-scan

    const results: ScanResult[] = []

    // 2. Deep scan the top 25 candidates
    for (const t of candidates) {
      try {
        // Fetch last 24 hours of 1H candles
        const end = Math.floor(Date.now() / 1000)
        const start = end - (24 * 3600)
        const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min60&start=${start}&end=${end}`)
        const klineJson = await klineRes.json() as any
        
        if (!klineJson.success || !klineJson.data?.time?.length) continue
        
        const { time, open, high, low, close, vol } = klineJson.data
        const candles: Candle[] = []
        for (let i = 0; i < time.length; i++) {
          candles.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
        }
        
        if (candles.length < 20) continue
        
        const closes = candles.map(c => c.close)
        const atrArr = atr(candles, 14)
        const adxArr = adx(candles, 14)
        const emaFast = ema(closes, 9)
        const emaSlow = ema(closes, 21)
        
        const lastClose = closes[closes.length - 1]
        const lastAtr = atrArr[atrArr.length - 1]
        const lastAdx = adxArr[adxArr.length - 1]
        
        const atrPct = (lastAtr / lastClose) * 100
        
        // Calculate how many times EMA crossed (choppiness indicator)
        let crosses = 0
        for (let i = 1; i < closes.length; i++) {
          const prevDiff = emaFast[i-1] - emaSlow[i-1]
          const currDiff = emaFast[i] - emaSlow[i]
          if ((prevDiff > 0 && currDiff < 0) || (prevDiff < 0 && currDiff > 0)) crosses++
        }
        
        // Grid Score Algorithm:
        // + Reward volatility (ATR%) -> want at least 1.5% to beat fees
        // + Reward choppiness (EMA crosses) -> more oscillations = more grid fills
        // - Penalize strong trends (ADX) -> ADX > 25 is bad for grids
        let score = 0
        let reason = ""
        
        score += atrPct * 15 // Volatility reward
        score += crosses * 10 // Choppiness reward
        score -= lastAdx * 2 // Trend penalty
        
        if (lastAdx > 30) {
          score -= 50 // Heavy penalty for strong trends
          reason = "Strong trend in progress"
        } else if (atrPct < 1.0) {
          score -= 30 // Penalty for low volatility
          reason = "Low volatility (fees will eat profits)"
        } else {
          reason = `Choppy market (${crosses} oscillations), healthy volatility`
        }
        
        results.push({
          symbol: t.symbol,
          score: Math.round(score),
          atrPct: parseFloat(atrPct.toFixed(2)),
          adx: parseFloat(lastAdx.toFixed(1)),
          volumeUsdt: Math.round(t.amount24),
          reason
        })
        
      } catch (err) {
        // Skip this coin if API fails
        continue
      }
    }
    
    // 3. Sort by best Grid Score and return top 5
    const topPicks = results.sort((a, b) => b.score - a.score).slice(0, 5)
    
    return NextResponse.json({ success: true, picks: topPicks })
    
  } catch (err: any) {
    console.error('[Scan Coins] Error:', err)
    return NextResponse.json({ success: false, error: 'Coin scan failed' }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { ema, atr, adx, rsi } from "@/lib/indicators"
import type { Candle } from "@/lib/mexc/public"
import { getConfig } from "@/lib/engine"
import { getExchangeClient } from "@/lib/exchange"

export const dynamic = "force-dynamic"
export const maxDuration = 60

interface ScanResult {
  symbol: string
  score: number
  liquidityScore: number
  meanReversionScore: number
  volatilityQuality: number
  atrPct: number
  adx: number
  spread: number
  volumeUsdt: number
  reason: string
  redFlags: string[]
}

// Calculate Hurst exponent approximation (mean-reversion detector)
// 0.5 = random walk, <0.5 = mean-reverting (good for grids), >0.5 = trending (bad)
function calculateHurst(closes: number[]): number {
  const n = closes.length
  if (n < 20) return 0.5
  
  // Calculate log returns
  const returns = []
  for (let i = 1; i < n; i++) {
    returns.push(Math.log(closes[i] / closes[i-1]))
  }
  
  // Simple Hurst approximation using variance ratio
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length
  
  // Calculate variance of cumulative returns (R/S analysis simplified)
  const cumReturns = []
  let cumSum = 0
  for (const r of returns) {
    cumSum += r - mean
    cumReturns.push(cumSum)
  }
  
  const range = Math.max(...cumReturns) - Math.min(...cumReturns)
  const stdDev = Math.sqrt(variance)
  
  if (stdDev === 0) return 0.5
  
  // R/S statistic
  const rs = range / stdDev
  // Hurst ≈ log(R/S) / log(n)
  const hurst = Math.log(rs) / Math.log(n)
  
  return Math.max(0, Math.min(1, hurst))
}

// Calculate bid-ask spread from ticker data
function calculateSpread(ticker: any): number {
  if (!ticker.bidPrice || !ticker.askPrice) return 999
  const mid = (ticker.bidPrice + ticker.askPrice) / 2
  const spread = ((ticker.askPrice - ticker.bidPrice) / mid) * 100
  return spread
}

// Detect recent pump/dump (toxic volatility)
function detectPumpDump(candles: Candle[]): { isToxic: boolean; reason: string } {
  const closes = candles.map(c => c.close)
  const last7 = closes.slice(-7 * 24) // Last 7 days of hourly candles
  const last24 = closes.slice(-24) // Last 24 hours
  
  const start7 = last7[0]
  const end7 = last7[last7.length - 1]
  const change7d = ((end7 - start7) / start7) * 100
  
  const start24 = last24[0]
  const end24 = last24[last24.length - 1]
  const change24h = ((end24 - start24) / start24) * 100
  
  // Toxic if: >20% move in 7 days OR >10% move in 24 hours
  if (Math.abs(change7d) > 20) {
    return { isToxic: true, reason: `7d move: ${change7d.toFixed(1)}% (pump/dump risk)` }
  }
  if (Math.abs(change24h) > 10) {
    return { isToxic: true, reason: `24h move: ${change24h.toFixed(1)}% (extreme volatility)` }
  }
  
  return { isToxic: false, reason: "Stable price action" }
}

export async function GET() {
  try {
    // 1. Fetch all MEXC contract tickers
    const cfg = await getConfig()
    const exchange = getExchangeClient(cfg.exchange)
    let tickerData: any[] = []
    if (exchange.fetchAllTickers) {
      const allTickers = await exchange.fetchAllTickers()
      tickerData = allTickers
    } else {
      const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
      const tickerJson = await tickerRes.json() as any
      tickerData = (tickerJson.data as any[])
    }
    const tickerJson = await tickerRes.json() as any
    
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
    
    const allTickers = tickerJson.data as any[]
    
    // HARD GATES: Only consider coins that pass liquidity filters
    const candidates = allTickers
      .filter(t => t.symbol.endsWith("_USDT"))
      .filter(t => t.amount24 > 500000000) // > $500M volume (10x stricter)
      .filter(t => Math.abs(t.riseFallRate) < 0.08) // < 8% move in 24h (stricter)
      .filter(t => t.bidPrice && t.askPrice) // Must have bid/ask data
      .map(t => ({
        ...t,
        spread: calculateSpread(t)
      }))
      .filter(t => t.spread < 0.05) // Spread must be < 0.05%
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 30) // Top 30 by volume to deep-scan

    const results: ScanResult[] = []

    // 2. Deep scan the top 30 candidates
    for (const t of candidates) {
      try {
        // Fetch 7 days of 1H candles for better analysis
        const end = Math.floor(Date.now() / 1000)
        const start = end - (7 * 24 * 3600)
        const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min60&start=${start}&end=${end}`)
        const klineJson = await klineRes.json() as any
        
        if (!klineJson.success || !klineJson.data?.time?.length) continue
        
        const { time, open, high, low, close, vol } = klineJson.data
        const candles: Candle[] = []
        for (let i = 0; i < time.length; i++) {
          candles.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
        }
        
        if (candles.length < 48) continue // Need at least 2 days of data
        
        const closes = candles.map(c => c.close)
        const atrArr = atr(candles, 14)
        const adxArr = adx(candles, 14)
        const rsiArr = rsi(closes, 14)
        const emaFast = ema(closes, 9)
        const emaSlow = ema(closes, 21)
        
        const lastClose = closes[closes.length - 1]
        const lastAtr = atrArr[atrArr.length - 1]
        const lastAdx = adxArr[adxArr.length - 1]
        const lastRsi = rsiArr[rsiArr.length - 1]
        
        const atrPct = (lastAtr / lastClose) * 100
        const hurst = calculateHurst(closes)
        const pumpDump = detectPumpDump(candles)
        
        // Calculate mean-reversion strength (EMA crosses around VWAP)
        let crosses = 0
        for (let i = 1; i < closes.length; i++) {
          const prevDiff = emaFast[i-1] - emaSlow[i-1]
          const currDiff = emaFast[i] - emaSlow[i]
          if ((prevDiff > 0 && currDiff < 0) || (prevDiff < 0 && currDiff > 0)) crosses++
        }
        
        // Count oscillations around 7-day VWAP
        const totalVol = candles.reduce((sum, c) => sum + c.volume, 0)
        const vwap = candles.reduce((sum, c) => sum + c.close * c.volume, 0) / totalVol
        let vwapCrosses = 0
        for (let i = 1; i < closes.length; i++) {
          if ((closes[i-1] > vwap && closes[i] < vwap) || (closes[i-1] < vwap && closes[i] > vwap)) {
            vwapCrosses++
          }
        }
        
        // Calculate 7-day price range (should be contained)
        const high7d = Math.max(...closes)
        const low7d = Math.min(...closes)
        const range7d = ((high7d - low7d) / low7d) * 100
        
        const redFlags: string[] = []
        
        // SCORING ALGORITHM (Quant-Grade)
        
        // 1. Liquidity Score (40% weight) - Most important
        let liquidityScore = 0
        const volumeScore = Math.min(t.amount24 / 1000000000, 1) * 100 // Normalize to $1B
        const spreadScore = Math.max(0, 100 - (t.spread * 2000)) // 0.05% = 0, 0% = 100
        liquidityScore = (volumeScore + spreadScore) / 2
        
        // 2. Mean-Reversion Score (30% weight) - Grid profitability
        let meanReversionScore = 0
        const hurstScore = Math.max(0, (0.5 - hurst) * 200) // Lower Hurst = better
        const crossScore = Math.min(crosses * 5, 100) // More crosses = better
        const vwapScore = Math.min(vwapCrosses * 3, 100)
        meanReversionScore = (hurstScore + crossScore + vwapScore) / 3
        
        // 3. Volatility Quality (20% weight) - Not just amount, but type
        let volatilityQuality = 0
        if (atrPct >= 1.5 && atrPct <= 5.0) {
          volatilityQuality = 100 // Sweet spot
        } else if (atrPct >= 1.0 && atrPct <= 7.0) {
          volatilityQuality = 70 // Acceptable
        } else {
          volatilityQuality = 30 // Too low or too high
        }
        
        // Penalty for toxic volatility (pump/dump)
        if (pumpDump.isToxic) {
          volatilityQuality *= 0.3 // Heavy penalty
          redFlags.push(pumpDump.reason)
        }
        
        // Penalty for strong trends
        if (lastAdx > 30) {
          meanReversionScore *= 0.5
          redFlags.push(`Strong trend (ADX: ${lastAdx.toFixed(1)})`)
        }
        
        // Penalty for extreme RSI
        if (lastRsi > 75 || lastRsi < 25) {
          volatilityQuality *= 0.7
          redFlags.push(`Extreme RSI: ${lastRsi.toFixed(1)}`)
        }
        
        // 4. Calculate final composite score
        let finalScore = (
          liquidityScore * 0.40 +
          meanReversionScore * 0.30 +
          volatilityQuality * 0.20 +
          10 // Base safety score
        )
        
        // Generate human-readable reason
        let reason = ""
        if (redFlags.length > 0) {
          reason = `⚠️ ${redFlags.join(", ")}`
        } else if (finalScore > 70) {
          reason = `✅ Excellent grid candidate (Hurst: ${hurst.toFixed(2)}, ${vwapCrosses} VWAP crosses)`
        } else if (finalScore > 50) {
          reason = `✓ Good grid candidate (moderate mean-reversion)`
        } else {
          reason = `⚠️ Marginal (low mean-reversion or liquidity)`
        }
        
        results.push({
          symbol: t.symbol,
          score: Math.round(finalScore),
          liquidityScore: Math.round(liquidityScore),
          meanReversionScore: Math.round(meanReversionScore),
          volatilityQuality: Math.round(volatilityQuality),
          atrPct: parseFloat(atrPct.toFixed(2)),
          adx: parseFloat(lastAdx.toFixed(1)),
          spread: parseFloat(t.spread.toFixed(4)),
          volumeUsdt: Math.round(t.amount24),
          reason,
          redFlags
        })
        
      } catch (err) {
        continue
      }
    }
    
    // 3. Sort by final score and return top 10
    const topPicks = results
      .filter(r => r.score > 40) // Only show viable candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
    
    return NextResponse.json({ 
      success: true, 
      picks: topPicks,
      scanned: results.length,
      timestamp: new Date().toISOString()
    })
    
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Scan failed" }, { status: 500 })
  }
}

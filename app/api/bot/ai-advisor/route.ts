import { NextResponse } from "next/server"
import { ema, atr, adx, bollinger } from "@/lib/indicators"
import { comboDna, comboParams } from "@/lib/combo-score"
import { db } from "@/lib/db"
import { botLogs } from "@/lib/db/schema"
import { livePrices } from "@/lib/mexc/ws"
import type { Candle } from "@/lib/mexc/public"
import { fetchDepth, depthNotionalNearMid } from "@/lib/mexc/public"
import { computeSafeGridSettings } from "@/lib/grid-sizing"

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

export async function GET() {
  try {
    // 1. Fetch top MEXC pairs by volume
    const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker", { cache: "no-store" })
    const tickerJson = await tickerRes.json() as any
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
    
    // $1M was not meaningfully liquid for a futures contract — easily one
    // or two large trades' worth of volume on a thin book. Raised to a
    // real floor; we're already scanning the top 100 by volume anyway.
    const MIN_VOLUME_24H = 15_000_000
    const candidates = (tickerJson.data as any[])
      .filter(t => t.symbol.endsWith("_USDT") && !t.symbol.includes("STOCK") && !t.symbol.includes("3L") && !t.symbol.includes("3S"))
      .filter(t => t.amount24 > MIN_VOLUME_24H)
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 100)

    // Watchlist Override: Always include currently active grid pairs
    try {
      const activePairs = await db.select({ symbol: gridConfigs.symbol }).from(gridConfigs)
      for (const pair of activePairs) {
        if (!candidates.find((c: any) => c.symbol === pair.symbol)) {
          const ticker = (tickerJson.data as any[]).find((t: any) => t.symbol === pair.symbol)
          if (ticker) candidates.push(ticker)
        }
      }
    } catch(e) { console.error("Watchlist override error:", e) } // Scan top 100 for wider net

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
        // Hard filters removed - let DNA score handle it
                
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
        
        const dna = comboDna(candles, 0.6, lastAdx)
        const params = comboParams(dna, lastClose)
        if (dna.rejected) continue // hard-gated: drift or trend too high for a grid entry
        const blendedScore = Math.round(Math.min(score, 100) * 0.35 + dna.score * 0.65) // DNA (drift-aware) dominates

        scoredMarkets.push({
          symbol: t.symbol,
          volumeUsdt: Math.round(t.amount24),
          atrPct: parseFloat(atrPct.toFixed(2)),
          adx: parseFloat(lastAdx.toFixed(1)),
          chop: parseFloat(chop.toFixed(1)),
          bbTouches,
          momentum3h: parseFloat(momentum3h.toFixed(2)),
          score: Math.round(score),
          dnaScore: dna.score,
          chopRatio: parseFloat(dna.chop.toFixed(1)),
          revRate: parseFloat(dna.revRate.toFixed(2)),
          driftPct: parseFloat(dna.driftPct.toFixed(1)),
          suggestedLeverage: params.suggestedLeverage,
          suggestedSpacingPct: parseFloat(params.spacingPct.toFixed(2)),
          suggestedLevels: params.levels,
          blendedScore: blendedScore
        })
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100))
      } catch (err) { continue }
    }

    // 3. Sort by OQS and take a wider shortlist, then verify real
    // order-book depth before finalizing picks — a coin can look calm on
    // historical candles and still be unsafe if the actual book is thin
    // relative to the position size the bot would place. This directly
    // targets "the bot's own order moves the price and trips its own
    // stop-loss", which historical price shape alone cannot detect.
    const shortlist = scoredMarkets.sort((a, b) => b.blendedScore - a.blendedScore).slice(0, 8)
    const safeSizingPreview = await computeSafeGridSettings(3)
    const depthChecked: typeof shortlist = []
    for (const m of shortlist) {
      if (depthChecked.length >= 3) break
      try {
        const depth = await fetchDepth(m.symbol)
        const currentPrice = livePrices[m.symbol] ?? 0
        if (!currentPrice) { depthChecked.push(m); continue }
        const nearMidNotional = depthNotionalNearMid(depth, currentPrice, 0.02)
        const estOrderNotional = (safeSizingPreview.availableBalance * safeSizingPreview.budgetPct / 100 / Math.max(1, safeSizingPreview.levels)) * m.suggestedLeverage
        const MIN_DEPTH_MULTIPLE = 25
        if (nearMidNotional < estOrderNotional * MIN_DEPTH_MULTIPLE) {
          await db.insert(botLogs).values({
            level: "info",
            message: `AI Advisor: ${m.symbol} skipped — thin book ($${nearMidNotional.toFixed(0)} resting near mid vs $${estOrderNotional.toFixed(2)} order size, need ${MIN_DEPTH_MULTIPLE}x)`,
          }).catch(() => {})
          continue
        }
        depthChecked.push(m)
      } catch {
        continue
      }
    }
    const topPicks = depthChecked

    // 4. Generate optimal parameters, capped to what the account can
    // actually fund. Market-quality scoring (DNA, chop, depth) picks WHICH
    // coins are safe to trade — this step ensures the recommended SIZE is
    // also safe, independent of what the quality scoring alone suggested.
    // Sizing every pick together (topPicks.length) so applying all of them
    // at once doesn't each independently claim a budgetPct that's only
    // safe in isolation.
    const finalSizing = await computeSafeGridSettings(topPicks.length)
    const recommendations = topPicks.map(m => {
      return {
        symbol: m.symbol,
        reason: `DNA: ${m.dnaScore} | Blend: ${m.blendedScore} | Chop: ${m.chopRatio} | Rev: ${m.revRate} | Drift: ${m.driftPct}% | Sized for ${finalSizing.totalPairs} pairs @ $${finalSizing.availableBalance.toFixed(2)} available`,
        levels: Math.min(m.suggestedLevels, finalSizing.levels),
        atrMult: parseFloat(Math.min(3, Math.max(0.3, m.suggestedSpacingPct / Math.max(m.atrPct, 0.1))).toFixed(2)), // DNA-derived ATR mult
        leverage: Math.max(1, Math.min(m.suggestedLeverage, finalSizing.leverage)),
        budgetPct: finalSizing.budgetPct,
        dnaScore: m.dnaScore,
        blendedScore: m.blendedScore,
        chopRatio: m.chopRatio,
        revRate: m.revRate,
        driftPct: m.driftPct,
        suggestedSpacingPct: m.suggestedSpacingPct
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

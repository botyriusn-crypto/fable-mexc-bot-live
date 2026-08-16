import { ema, atr, adx, bollinger } from "./indicators"
import { comboDna, comboParams } from "./combo-score"
import { db } from "./db"
import { botLogs, gridConfigs } from "./db/schema"
import { livePrices } from "./mexc/ws"
import { fetchDepth, depthNotionalNearMid } from "./mexc/public"
import type { Candle } from "./mexc/public"
import { computeSafeGridSettings } from "./grid-sizing"
import { eq } from "drizzle-orm"

// Known leveraged-ETF / tokenized-stock tickers on MEXC. These often can't
// open a short (MEXC rejects with 2009 Position is nonexistent), which
// breaks a COMBO grid's naked short leg — the STOCK/3L/3S substring filter
// doesn't catch names like SOXL that don't contain those substrings.
const LEVERAGED_ETF_DENYLIST = new Set([
  "SOXL_USDT", "SOXS_USDT", "TQQQ_USDT", "SQQQ_USDT",
  "SPXL_USDT", "SPXS_USDT", "TNA_USDT", "TZA_USDT",
  "LABU_USDT", "LABD_USDT", "FAS_USDT", "FAZ_USDT",
  "TMF_USDT", "TMV_USDT", "UVXY_USDT", "SVXY_USDT",
])

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

export interface GridAiRecommendation {
  symbol: string
  reason: string
  levels: number
  atrMult: number
  leverage: number
  budgetPct: number
  dnaScore: number
  blendedScore: number
  chopRatio: number
  revRate: number
  driftPct: number
  suggestedSpacingPct: number
}

export interface GridAiResult {
  success: boolean
  recommendations: GridAiRecommendation[]
  applied: string[]
  error?: string
}

export async function runGridAiAdvisor(autoApply: boolean): Promise<GridAiResult> {
  try {
    const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker", { cache: "no-store" })
    const tickerJson = await tickerRes.json() as any
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")

    const MIN_VOLUME_24H = 15_000_000
    const candidates = (tickerJson.data as any[])
      .filter(t =>
        t.symbol.endsWith("_USDT") &&
        !t.symbol.includes("STOCK") && !t.symbol.includes("3L") && !t.symbol.includes("3S") &&
        !LEVERAGED_ETF_DENYLIST.has(t.symbol)
      )
      .filter(t => t.amount24 > MIN_VOLUME_24H)
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 100)

    try {
      // Only re-add already-tracked pairs if they still pass the SAME
      // safety filters as any new candidate — a symbol added before the
      // denylist/volume-floor existed (e.g. SOXL_USDT) must not get a
      // permanent bypass just because it's already in the table.
      const activePairs = await db.select({ symbol: gridConfigs.symbol }).from(gridConfigs)
      for (const pair of activePairs) {
        if (LEVERAGED_ETF_DENYLIST.has(pair.symbol)) continue
        if (pair.symbol.includes("STOCK") || pair.symbol.includes("3L") || pair.symbol.includes("3S")) continue
        if (!candidates.find((c: any) => c.symbol === pair.symbol)) {
          const ticker = (tickerJson.data as any[]).find((t: any) => t.symbol === pair.symbol)
          if (ticker && ticker.amount24 > MIN_VOLUME_24H) candidates.push(ticker)
        }
      }
    } catch (e) { console.error("Watchlist override error:", e) }

    const scoredMarkets: any[] = []

    for (const t of candidates) {
      try {
        const end = Math.floor(Date.now() / 1000)
        const start = end - (3 * 24 * 3600)
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

        const chop = calcChop(candles, 14)

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

        const momentum3h = closes.length >= 13 ? ((closes[closes.length - 1] - closes[closes.length - 13]) / closes[closes.length - 13]) * 100 : 0
        if (momentum3h < -3.0) continue

        let score = 0
        score += (chop - 50) * 2
        score += bbTouches * 3
        score += atrPct * 5
        score -= (lastAdx - 20) * 1.5

        const dna = comboDna(candles, 0.6, lastAdx)
        const params = comboParams(dna, lastClose)
        if (dna.rejected) continue
        const blendedScore = Math.round(Math.min(score, 100) * 0.35 + dna.score * 0.65)

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
          blendedScore,
        })

        await new Promise(r => setTimeout(r, 100))
      } catch (err) { continue }
    }

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

    const finalSizing = await computeSafeGridSettings(topPicks.length)
    const recommendations: GridAiRecommendation[] = topPicks.map(m => ({
      symbol: m.symbol,
      reason: `DNA: ${m.dnaScore} | Blend: ${m.blendedScore} | Chop: ${m.chopRatio} | Rev: ${m.revRate} | Drift: ${m.driftPct}% | Sized for ${finalSizing.totalPairs} pairs @ $${finalSizing.availableBalance.toFixed(2)} available`,
      levels: Math.min(m.suggestedLevels, finalSizing.levels),
      atrMult: parseFloat(Math.min(3, Math.max(0.3, m.suggestedSpacingPct / Math.max(m.atrPct, 0.1))).toFixed(2)),
      leverage: Math.max(1, Math.min(m.suggestedLeverage, finalSizing.leverage)),
      budgetPct: finalSizing.budgetPct,
      dnaScore: m.dnaScore,
      blendedScore: m.blendedScore,
      chopRatio: m.chopRatio,
      revRate: m.revRate,
      driftPct: m.driftPct,
      suggestedSpacingPct: m.suggestedSpacingPct,
    }))

    for (const rec of recommendations) {
      const entryPrice = livePrices[rec.symbol]
      if (entryPrice) {
        await db.insert(botLogs).values({
          level: "ai_pick",
          message: `AI Pick (OQS): ${rec.symbol}`,
          details: { symbol: rec.symbol, entryPrice, settings: rec },
        })
      }
    }

    const applied: string[] = []
    if (autoApply) {
      for (const rec of recommendations) {
        try {
          const existing = await db.select().from(gridConfigs).where(eq(gridConfigs.symbol, rec.symbol)).limit(1)
          if (existing.length > 0) continue
          await db.insert(gridConfigs).values({
            symbol: rec.symbol,
            timeframe: "Min15",
            direction: "neutral",
            levels: rec.levels,
            rangeAtrMult: rec.atrMult,
            leverage: rec.leverage,
            budgetPct: rec.budgetPct,
            feeMarginMult: 3,
            autoPause: true,
            makerMode: true,
            // Auto-enabled by explicit choice: the liquidity floor, ADX
            // trend gate, drift gate, order-book depth check, and
            // leveraged-ETF denylist are the safety net here, not a human
            // reviewing each pick before it goes live.
            enabled: true,
            paused: false,
          })
          applied.push(rec.symbol)
          await db.insert(botLogs).values({
            level: "trade",
            message: `AI Advisor auto-built and enabled COMBO grid for ${rec.symbol}: levels=${rec.levels} atrMult=${rec.atrMult}x leverage=${rec.leverage}x budget=${rec.budgetPct}%`,
          }).catch(() => {})
        } catch (err) {
          console.error(`AI Advisor auto-apply failed for ${rec.symbol}:`, err)
        }
      }
    }

    return { success: true, recommendations, applied }
  } catch (err: any) {
    console.error("AI Advisor Error:", err)
    return { success: false, recommendations: [], applied: [], error: err?.message || "AI scan failed" }
  }
}

const AUTO_RUN_INTERVAL_MS = 5 * 60 * 60 * 1000 // 5 hours
let lastAutoRun = 0

export async function maybeRunGridAiAdvisorAuto(): Promise<void> {
  const now = Date.now()
  if (now - lastAutoRun < AUTO_RUN_INTERVAL_MS) return
  lastAutoRun = now
  try {
    const result = await runGridAiAdvisor(true)
    if (result.applied.length > 0) {
      console.log(`[AI Grid Advisor] Auto-built ${result.applied.length} new pair(s): ${result.applied.join(", ")}`)
    }
  } catch (err) {
    console.error("[AI Grid Advisor] Scheduled auto-run failed:", err)
  }
}

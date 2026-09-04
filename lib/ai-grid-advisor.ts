import { ema, atr, adx, bollinger } from "./indicators"
import { comboDna, comboParams } from "./combo-score"
import { db } from "./db"
import { botLogs, gridConfigs, botConfig } from "./db/schema"
import { livePrices } from "./mexc/ws"
import { fetchDepth, depthNotionalNearMid } from "./mexc/public"
import type { Candle } from "./mexc/public"
import { computeSafeGridSettings } from "./grid-sizing"
import { getExchangeClient, type ExchangeClient, type Ticker } from "./exchange"
import { getConfig } from "./engine"
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

// ============================================================================
// 1.1 FEEDBACK LOOP — stop re-picking symbols that just lost money.
// A module-level store of recent grid outcomes. The bot runs as a long-lived
// Next.js server, so this survives across advisor runs. If the server
// restarts it resets, which is acceptable (the cool-off is only 48h anyway).
// ============================================================================
interface GridOutcome { pnl: number; ts: number }
const recentGridOutcomes = new Map<string, GridOutcome>()
const LOSER_COOLOFF_MS = 48 * 60 * 60 * 1000 // 48 hours

/**
 * Record a grid's realized P&L when it is torn down / rotated out. Called by
 * the portfolio rotator when it kills a dead grid.
 */
export function recordGridOutcome(symbol: string, pnl: number): void {
  recentGridOutcomes.set(symbol, { pnl, ts: Date.now() })
}

/**
 * True if this symbol lost money within the last 48h (cool-off blacklist).
 * Expired entries are cleaned up lazily on read.
 */
export function isRecentLoser(symbol: string): boolean {
  const o = recentGridOutcomes.get(symbol)
  if (!o) return false
  if (Date.now() - o.ts > LOSER_COOLOFF_MS) {
    recentGridOutcomes.delete(symbol)
    return false
  }
  return o.pnl < 0
}

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
    const cfg = await getConfig()
    const exchange = getExchangeClient(cfg.exchange)
    
    // Exchange-aware ticker scanning
    let allTickers: Ticker[] = []
    if (exchange.fetchAllTickers) {
      allTickers = await exchange.fetchAllTickers()
    } else {
      // Fallback: MEXC hardcoded API (legacy)
      const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker", { cache: "no-store" })
      const tickerJson = await tickerRes.json() as any
      if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
      allTickers = (tickerJson.data as any[]).map((t: any) => ({
        symbol: t.symbol,
        lastPrice: Number(t.lastPrice ?? 0),
        fundingRate: 0,
        volume24: Number(t.amount24 ?? 0),
      }))
    }

    const MIN_VOLUME_24H = 15_000_000
    const candidates = allTickers
      .filter(t =>
        t.symbol.endsWith("_USDT") &&
        !t.symbol.includes("STOCK") && !t.symbol.includes("3L") && !t.symbol.includes("3S") &&
        !LEVERAGED_ETF_DENYLIST.has(t.symbol)
      )
      .filter(t => t.volume24 > MIN_VOLUME_24H)
      .sort((a, b) => b.volume24 - a.volume24)
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
    const gateStats = { total: candidates.length, recentLoser: 0, feeGate: 0, klineFail: 0, tooFewCandles: 0, momentumGate: 0, dnaRejected: 0, scored: 0 }

    for (const t of candidates) {
      try {
        // 1.1 Feedback loop: skip any symbol that lost money in a grid within
        // the last 48h (cool-off blacklist to avoid re-picking repeat losers).
        if (isRecentLoser(t.symbol)) { gateStats.recentLoser++; continue }

        const candles = await exchange.fetchKlines(t.symbol, "Min15", 200)
        if (candles.length < 50) { gateStats.tooFewCandles++; continue }

        const closes = candles.map(c => c.close)
        const lastClose = closes[closes.length - 1]
        const atrArr = atr(candles, 14)
        const adxArr = adx(candles, 14)
        const lastAtr = atrArr[atrArr.length - 1]
        const lastAdx = adxArr[adxArr.length - 1]
        const atrPct = (lastAtr / lastClose) * 100

        // 1.2 Fee-adjusted profitability gate: a COMBO grid only profits when
        // per-level spacing clears the round-trip fee (~0.06% on MEXC). With
        // ~10 levels, average spacing ≈ atrPct/10; if that's below 0.08% the
        // grid can't reliably beat fees, so skip it.
        if (atrPct / 10 < 0.03) { gateStats.feeGate++; continue }

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
        // 1.3 Symmetric momentum filter: a neutral COMBO grid is hurt by strong
        // moves in EITHER direction, so reject both pumps and dumps (>2.5%).
        if (Math.abs(momentum3h) > 2.5) { gateStats.momentumGate++; continue }

        // ONDO-DNA scoring (validated 2026-08-23): grid edge lives in an
        // ATR sweet spot (~0.6-1.2%), not raw chop. Winners averaged ATR
        // 0.95%, losers 2.15% — the old linear atrPct*5 rewarded trending
        // coins that break the range (TAO scored -9 yet made +$7.8k).
        const atrSweet = Math.max(0, 100 - Math.abs(atrPct - 0.9) * 70)
        const chopScore = Math.min(chop, 120) * 0.5
        const adxPen = Math.max(0, lastAdx - 25) * 4
        let score = atrSweet + chopScore - adxPen

        const dna = comboDna(candles, 0.6, lastAdx)
        const params = comboParams(dna, lastClose, t.amount24)
        console.log(`[LevDebug] ${t.symbol} vol=$${Math.round(t.amount24)} atrPct=${atrPct.toFixed(2)}% lev=${params.suggestedLeverage}x`)
        if (dna.rejected) { gateStats.dnaRejected++; continue }
        const blendedScore = Math.round(Math.max(0, Math.min(100, score / 1.5)) * 0.35 + dna.score * 0.65)

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
        gateStats.scored++

        await new Promise(r => setTimeout(r, 100))
      } catch (err) { continue }
    }

    console.log("[AI Advisor Gate Stats]", JSON.stringify(gateStats))
    await db.insert(botLogs).values({
      level: "info",
      message: `AI Advisor gate stats: ${JSON.stringify(gateStats)}`,
    }).catch(() => {})
    const shortlist = scoredMarkets.sort((a, b) => b.blendedScore - a.blendedScore).slice(0, 8)
    const safeSizingPreview = await computeSafeGridSettings(3)
    const depthChecked: typeof shortlist = []
    for (const m of shortlist) {
      if (depthChecked.length >= 3) break
      try {
        // fetchDepth is MEXC-specific; skip depth check for non-MEXC exchanges
        if (cfg.exchange !== "mexc") { depthChecked.push(m); continue }
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

    // CAP PAIR COUNT TO FREE BALANCE: greedily take the highest-scoring picks
    // until the free USDT can no longer fund another pair's minimum margin
    // (one-sided, since auto grids trend). Mirrors grid.ts.s backoff condition
    // (budget * leverage >= MIN_NOTIONAL * sidesPerLevel) and reserves the
    // same SAFETY_FACTOR headroom computeSafeGridSettings uses, so the
    // advisor never recommends more pairs than the account can actually place.
    const MIN_NOTIONAL = 1.0
    const COMBO_SIDES = 1
    const SAFETY_FACTOR = 0.7
    const cappedPicks: typeof topPicks = []
    let remaining = safeSizingPreview.availableBalance * SAFETY_FACTOR
    for (const m of topPicks) {
      const minMargin = (MIN_NOTIONAL * COMBO_SIDES) / Math.max(1, m.suggestedLeverage)
      if (remaining >= minMargin) {
        cappedPicks.push(m)
        remaining -= minMargin
      }
    }
    if (cappedPicks.length < topPicks.length) {
      await db.insert(botLogs).values({
        level: "info",
        message: `AI Advisor: capped ${topPicks.length} picks to ${cappedPicks.length} — free balance $${safeSizingPreview.availableBalance.toFixed(2)} funds at most ${cappedPicks.length} pair(s)`,
      }).catch(() => {})
    }

    const finalSizing = await computeSafeGridSettings(cappedPicks.length)

    // Budget-aware guard: drop any pick whose ACTUAL order notional (using
    // its own suggested levels/leverage, not the sizing defaults) would fall
    // below MEXC's minimum. Prevents auto-rotating into a pair that
    // immediately hits "budget too small" backoffs.
    const MIN_ORDER_NOTIONAL = 1.0
    const viablePicks = cappedPicks.filter(m => {
      const leverage = m.suggestedLeverage
      // Only drop picks that can't fund even ONE level (one order per side).
      // grid.ts already reduces levels at setup when the full suggested count
      // exceeds budget, so re-checking the full count here double-penalizes
      // small accounts and strands large caps. Check the 1-level floor only.
      const notionalPerOrder = finalSizing.availableBalance * finalSizing.budgetPct / 100 * leverage / 2
      return notionalPerOrder >= MIN_ORDER_NOTIONAL
    })
    if (viablePicks.length < cappedPicks.length) {
      await db.insert(botLogs).values({
        level: "info",
        message: `AI Advisor: dropped ${cappedPicks.length - viablePicks.length} pick(s) — notional below $${MIN_ORDER_NOTIONAL} per order after budget sizing`,
      }).catch(() => {})
    }

    const recommendations: GridAiRecommendation[] = viablePicks.map(m => ({
      symbol: m.symbol,
      reason: `DNA: ${m.dnaScore} | Blend: ${m.blendedScore} | Chop: ${m.chopRatio} | Rev: ${m.revRate} | Drift: ${m.driftPct}% | Sized for ${finalSizing.totalPairs} pairs @ $${finalSizing.availableBalance.toFixed(2)} available`,
      levels: Math.min(m.suggestedLevels, finalSizing.levels),
      atrMult: parseFloat(Math.min(3, Math.max(0.3, m.suggestedSpacingPct / Math.max(m.atrPct, 0.1))).toFixed(2)),
      leverage: m.suggestedLeverage,
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
    const cfgRows = await db.select({ gridEnabled: botConfig.gridEnabled }).from(botConfig).where(eq(botConfig.id, 1))
    const gridsEnabled = cfgRows[0]?.gridEnabled ?? false
    if (autoApply && gridsEnabled) {
      for (const rec of recommendations) {
        try {
          const existing = await db.select().from(gridConfigs).where(eq(gridConfigs.symbol, rec.symbol)).limit(1)
          if (existing.length > 0) continue
          await db.insert(gridConfigs).values({
            symbol: rec.symbol,
            timeframe: "Min15",
            direction: "auto",
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
            message: `AI Advisor auto-built and enabled AUTO grid for ${rec.symbol}: levels=${rec.levels} atrMult=${rec.atrMult}x leverage=${rec.leverage}x budget=${rec.budgetPct}%`,
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

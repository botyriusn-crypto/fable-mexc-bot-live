import type { Candle } from "./mexc/public"
import type { IndicatorSnapshot } from "./indicators"
import { db } from "./db"
import { classifierDecisions, botConfig, botLogs } from "./db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { fetchTicker, fetchAllTickers, fetchKlines, type BulkTicker } from "./mexc/public"
import { recordOutcome, type SniperFeatures } from "./advisor"

// Tunable rule parameters (Option A: exposed for display + advisor tuning).
export const MIN_CONFIDENCE = 0.7

// Shorts are structurally unprofitable on the 5-min timeframe. Backtested
// exhaustively: no stop-width x R:R combination reaches break-even (best was
// 1.0 ATR / 1:1 at -7R), and the trend filter does not help (shorts lose in
// every regime). Longs are +6R. Disabled permanently - re-enable only after
// re-validating on a slower timeframe.
export const SNIPER_SHORTS_ENABLED = false

export const SNIPER_PARAMS = {
  sweepLookback: 20,
  volumeSurgeMult: 2.0,
  sigmaExtreme: 3.5,
  fundingThreshold: 0.0005,
  minVolumeUsdt: 1_000_000,
  tpSlRatio: 4,
  resolveAfterBuckets: 6,
  minStopPct: 0.008,
} as const

export interface SniperSignal {
  direction: "long" | "short" | null
  reason: string
  confidence: number
  stopLoss: number
  takeProfit: number
  // Signal characteristics (for advisor grading + UI display)
  signalType: "sweep" | "sigma" | null
  volSurge: number
  z: number
  fundingRate: number
}

const SWEEP_LOOKBACK = SNIPER_PARAMS.sweepLookback
const VOLUME_SURGE_MULT = SNIPER_PARAMS.volumeSurgeMult
const SIGMA_EXTREME = SNIPER_PARAMS.sigmaExtreme

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

export interface SniperOverrides {
  sigmaExtreme?: number
  volumeSurgeMult?: number
  minStopPct?: number
  tpSlRatio?: number
  // A/B test toggles (defaults match current production behavior)
  bearishPrevCloseConfirm?: boolean   // default true: bearishReclaim requires prevCandle.close < swingHigh
  shortAllowNeutral?: boolean         // default true: exhaustedUp allows trendDown || trendNeutral
  sweepAllowNeutral?: boolean         // default true: sweeps allow trendNeutral (but never counter-trend)
  longStopBufferAtr?: boolean         // default false: long stop uses * 0.998 (pct), not + atrBuffer
  shortStopBufferPct?: boolean        // default false: short stop uses + atrBuffer, not * 1.002 (pct)
  tpSlRatioSigma?: number             // if set, sigma signals use this R:R instead of tpSlRatio
}

export function detectSniper(candles: Candle[], snap: IndicatorSnapshot, fundingRate = 0, overrides: SniperOverrides = {}): SniperSignal {
  const none: SniperSignal = { direction: null, reason: "no dislocation", confidence: 0, stopLoss: 0, takeProfit: 0, signalType: null, volSurge: 0, z: 0, fundingRate }
  if (candles.length < 60) return none

  const sigmaExtreme = overrides.sigmaExtreme ?? SIGMA_EXTREME
  const volumeSurgeMult = overrides.volumeSurgeMult ?? VOLUME_SURGE_MULT
  const bearishPrevCloseConfirm = overrides.bearishPrevCloseConfirm ?? true
  const shortAllowNeutral = overrides.shortAllowNeutral ?? true
  const sweepAllowNeutral = overrides.sweepAllowNeutral ?? true
  const longStopBufferAtr = overrides.longStopBufferAtr ?? false
  const shortStopBufferPct = overrides.shortStopBufferPct ?? false

  const last = candles[candles.length - 1]
  const prev = candles.slice(-SWEEP_LOOKBACK - 1, -1)
  const swingLow = Math.min(...prev.map(c => c.low))
  const swingHigh = Math.max(...prev.map(c => c.high))
  const avgVol = avg(prev.map(c => c.volume))
  const volSurge = avgVol > 0 ? last.volume / avgVol : 1

  const closes = candles.map(c => c.close)
  const window = closes.slice(-100)
  const mean = avg(window)
  const sd = Math.sqrt(avg(window.map(c => (c - mean) ** 2))) || 1
  const z = (last.close - mean) / sd

  // Trend filter: mean-reversion only WITH the longer-horizon trend.
  // The z-score measures dislocation from the recent 100-candle mean. The
  // trend is the direction of the longer-term center: compare the recent
  // 100-candle mean against the mean of the candles BEFORE it. If the recent
  // center is higher, the trend is up (dips are buyable); if lower, the trend
  // is down and "buy the dip" is a falling knife. This is what was killing the
  // long side (42% hit rate): sigma-longs kept catching knives in a downtrend.
  const older = closes.slice(0, Math.max(0, closes.length - 100))
  const olderMean = older.length > 0 ? avg(older) : mean
  const trendUp = mean > olderMean
  const trendDown = mean < olderMean
  const trendNeutral = Math.abs(mean - olderMean) / olderMean < 0.05;

  // Sweeps now carry the SAME trend gate as sigma. A bearish sweep (pierce
  // swing high -> reject) in an uptrend is just a pullback, not a reversal:
  // shorting it is how the short-sweep bucket collapsed to 4.5% accuracy.
  const bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= volumeSurgeMult && (trendUp || (sweepAllowNeutral && trendNeutral))
  const prevCandle = candles[candles.length - 2];
  const bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && (!bearishPrevCloseConfirm || prevCandle.close < swingHigh) && volSurge >= volumeSurgeMult && (trendDown || (sweepAllowNeutral && trendNeutral))

  const exhaustedDown = z < -sigmaExtreme && last.close > last.open && trendUp
  const exhaustedUp = z > sigmaExtreme && last.close < last.open && (trendDown || (shortAllowNeutral && trendNeutral))
  // Sigma confidence scales with how far |z| exceeds the threshold, so the
  // confidence floor and the "top N by confidence" sort actually discriminate
  // (weak sigma ~0.5 -> rejected by a 0.6 floor; strong sigma ~0.9 -> kept).
  const sigmaConfidence = 0.5 + Math.min(0.4, (Math.abs(z) - sigmaExtreme) * 0.15)

  let direction: "long" | "short" | null = null
  let confidence = 0
  let reason = ""
  let extreme = 0
  let signalType: "sweep" | "sigma" | null = null

  if (bullishReclaim) {
    direction = "long"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05
    reason = `Liquidity sweep: pierced ${swingLow.toFixed(6)} then reclaimed w/ ${volSurge.toFixed(1)}x volume`; extreme = last.low; signalType = "sweep"
  } else if (bearishReclaim) {
    direction = "short"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05
    reason = `Liquidity sweep: pierced ${swingHigh.toFixed(6)} then rejected w/ ${volSurge.toFixed(1)}x volume`; extreme = last.high; signalType = "sweep"
  } else if (exhaustedDown) {
    direction = "long"; confidence = sigmaConfidence
    reason = `Sigma exhaustion: z=${z.toFixed(1)} crash w/ bullish reversal candle`; extreme = last.low; signalType = "sigma"
  } else if (exhaustedUp) {
    direction = "short"; confidence = sigmaConfidence
    reason = `Sigma exhaustion: z=${z.toFixed(1)} blow-off w/ bearish reversal candle`; extreme = last.high; signalType = "sigma"
  }

  if (!direction) return none

  if (direction === "short" && !SNIPER_SHORTS_ENABLED) return none

  if (direction === "short" && fundingRate > SNIPER_PARAMS.fundingThreshold) { confidence += 0.1; reason += " + crowded longs (funding)" }
  if (direction === "long" && fundingRate < -SNIPER_PARAMS.fundingThreshold) { confidence += 0.1; reason += " + crowded shorts (funding)" }

  const entry = last.close
  const atrBuffer = snap.atr * 0.5;
  const structuralStop = direction === "long"
    ? (longStopBufferAtr ? Math.min(extreme, last.low) + atrBuffer : Math.min(extreme, last.low) * 0.998)
    : (shortStopBufferPct ? Math.max(extreme, last.high) * 1.002 : Math.max(extreme, last.high) + atrBuffer)
  const minStopPct = overrides.minStopPct ?? SNIPER_PARAMS.minStopPct
  // REJECT sub-noise signals (validated): a structural stop tighter than
  // minStopPct means spread+slippage+wicks kill the trade. Do NOT widen —
  // the setup geometry itself is invalid.
  const structuralRisk = Math.abs(entry - structuralStop) / entry
  if (structuralRisk < minStopPct) return none
  const stopLoss = structuralStop
  const risk = Math.abs(entry - stopLoss)
  if (risk <= 0) return none
  const tpSlRatio = overrides.tpSlRatio ?? SNIPER_PARAMS.tpSlRatio
  const tpSlRatioSigma = overrides.tpSlRatioSigma ?? tpSlRatio
  const effectiveTpSlRatio = signalType === "sigma" ? tpSlRatioSigma : tpSlRatio
  const takeProfit = direction === "long" ? entry + risk * effectiveTpSlRatio : entry - risk * effectiveTpSlRatio

  return { direction, reason, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit, signalType, volSurge, z, fundingRate }
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal, entryTime: number) {
  if (!sig.direction) return
  try {
    await db.insert(classifierDecisions).values({
      symbol, timeframe, candleTime,
      candidateDirection: sig.direction,
      strategy: "sniper",
      regime: "neutral",
      entryPrice: entry,
      confirmationMode: "ml",
      logisticAllowed: true,
      logisticConfidence: sig.confidence,
      lorentzianDirection: sig.direction,
      lorentzianVote: 1,
      lorentzianConfidence: sig.confidence,
      lorentzianAllowed: true,
      // Store signal characteristics so the advisor can grade counterfactually.
      lorentzianFilters: { signalType: sig.signalType, volSurge: sig.volSurge, z: sig.z, fundingRate: sig.fundingRate, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, entryTime },
      finalAllowed: true,
      reason: sig.reason,
    }).onConflictDoNothing()
  } catch (err) {}
}

function tfSeconds(tf: string): number {
  const m = /Min(\d+)/.exec(tf)
  return m ? parseInt(m[1], 10) * 60 : 300
}

// Resolve sniper candidates by walking forward candle-by-candle from entry and
// checking which level was actually hit first — the real stop-loss or the real
// take-profit — rather than sampling price at a fixed 30-minute mark. This is
// the only resolution that tells the truth about a 4:1 reward:risk trade.
// Returns the number of decisions resolved this pass.
export async function resolveSniperDecisions(): Promise<number> {
  const unresolved = await db.select().from(classifierDecisions).where(
    and(eq(classifierDecisions.strategy, "sniper"), isNull(classifierDecisions.resolvedAt))
  )
  let resolved = 0
  for (const d of unresolved) {
    const tfSec = tfSeconds(d.timeframe)
    const curBucket = Math.floor(Date.now() / 1000 / tfSec)
    if (curBucket - d.candleTime < SNIPER_PARAMS.resolveAfterBuckets) continue

    // Stored stop/take levels (added to lorentzianFilters at record time).
    const filters = (d.lorentzianFilters ?? null) as any as (SniperFeatures & { stopLoss?: number; takeProfit?: number; entryTime?: number }) | null
    const stopLoss = filters?.stopLoss
    const takeProfit = filters?.takeProfit

    // Legacy rows (recorded before stop/take were stored) fall back to the old
    // ticker check so they still resolve rather than hanging forever.
    if (stopLoss == null || takeProfit == null) {
      const ticker: any = await fetchTicker(d.symbol).catch(() => null)
      const price = ticker?.lastPrice ?? ticker?.price
      if (!price) continue
      const ret = ((price - d.entryPrice) / d.entryPrice) * 100
      const actual = ret > 0.05 ? "long" : ret < -0.05 ? "short" : "neutral"
      const correct = d.candidateDirection === actual
      await db.update(classifierDecisions).set({
        outcomeDirection: actual,
        outcomeReturn: ret,
        outcomeCorrectLogistic: correct,
        outcomeCorrectLorentzian: correct,
        resolvedAt: sql`NOW()`,
      }).where(eq(classifierDecisions.id, d.id))
      const sig = (d.lorentzianFilters ?? null) as any as SniperFeatures | null
      if (sig) await recordOutcome(sig, d.candidateDirection, d.logisticConfidence, correct, ret).catch(() => {})
      resolved++
      continue
    }

    // Walk forward from the entry candle to determine which level hit first.
    const candles = await fetchKlines(d.symbol, d.timeframe, 200).catch(() => null)
    if (!candles || candles.length < 2) continue
    const sorted = [...candles].sort((a, b) => a.time - b.time)
    const entryIdx = filters?.entryTime != null
      ? sorted.findIndex((c) => c.time === filters.entryTime)
      : sorted.findIndex((c) => Math.floor(c.time / tfSec) === d.candleTime)
    if (entryIdx < 0) continue

    const isLong = d.candidateDirection === "long"
    let outcome: "tp" | "sl" | "open" = "open"
    let exitPrice = d.entryPrice

    for (let i = entryIdx + 1; i < sorted.length; i++) {
      const c = sorted[i]
      if (isLong) {
        // Conservative: if both levels are inside one candle, assume SL first.
        if (c.low <= stopLoss) { outcome = "sl"; exitPrice = stopLoss; break }
        if (c.high >= takeProfit) { outcome = "tp"; exitPrice = takeProfit; break }
      } else {
        if (c.high >= stopLoss) { outcome = "sl"; exitPrice = stopLoss; break }
        if (c.low <= takeProfit) { outcome = "tp"; exitPrice = takeProfit; break }
      }
    }

    if (outcome === "open") continue // neither level hit yet — leave for next pass

    const risk = Math.abs(d.entryPrice - stopLoss)
    const rMultiple = risk > 0 ? ((exitPrice - d.entryPrice) / risk) * (isLong ? 1 : -1) : 0
    const correct = outcome === "tp"

    await db.update(classifierDecisions).set({
      outcomeDirection: correct ? d.candidateDirection : (isLong ? "short" : "long"),
      outcomeReturn: rMultiple, // R-multiple (not raw %), so sumReturn = total R
      outcomeCorrectLogistic: correct,
      outcomeCorrectLorentzian: correct,
      resolvedAt: sql`NOW()`,
    }).where(eq(classifierDecisions.id, d.id))

    const sig = (d.lorentzianFilters ?? null) as any as SniperFeatures | null
    if (sig) await recordOutcome(sig, d.candidateDirection, d.logisticConfidence, correct, rMultiple).catch(() => {})
    resolved++
  }
  return resolved
}

// Live performance stats for the sniper signal (Option A: rule-based, no weights).
export async function getSniperStats() {
  const rows = await db.select().from(classifierDecisions)
    .where(eq(classifierDecisions.strategy, "sniper"))
    .orderBy(sql`created_at DESC`)
    .limit(500)
  const resolved = rows.filter(d => d.resolvedAt)
  const correct = resolved.filter(d => d.outcomeCorrectLogistic).length

  const sweeps = resolved.filter(d => (d.lorentzianFilters as any)?.signalType === "sweep")
  const sigmas = resolved.filter(d => (d.lorentzianFilters as any)?.signalType === "sigma")
  const sweepCorrect = sweeps.filter(d => d.outcomeCorrectLogistic).length
  const sigmaCorrect = sigmas.filter(d => d.outcomeCorrectLogistic).length

  const longs = resolved.filter(d => d.candidateDirection === "long")
  const shorts = resolved.filter(d => d.candidateDirection === "short")
  const longCorrect = longs.filter(d => d.outcomeCorrectLogistic).length
  const shortCorrect = shorts.filter(d => d.outcomeCorrectLogistic).length

  const high = resolved.filter(d => d.logisticConfidence >= 0.70)
  const mid = resolved.filter(d => d.logisticConfidence >= 0.55 && d.logisticConfidence < 0.70)
  const low = resolved.filter(d => d.logisticConfidence < 0.55)
  const highCorrect = high.filter(d => d.outcomeCorrectLogistic).length
  const midCorrect = mid.filter(d => d.outcomeCorrectLogistic).length
  const lowCorrect = low.filter(d => d.outcomeCorrectLogistic).length

  const recent = resolved
    .filter(d => d.resolvedAt)
    .sort((a, b) => new Date(b.resolvedAt as any).getTime() - new Date(a.resolvedAt as any).getTime())
    .slice(0, 50)
  const recentCorrect = recent.filter(d => d.outcomeCorrectLogistic).length

  const pending = rows.filter(d => !d.resolvedAt)
  const topRow = pending[0] ?? rows[0] ?? null
  const topCandidate = topRow ? {
    symbol: topRow.symbol,
    direction: topRow.candidateDirection,
    confidence: topRow.logisticConfidence,
    createdAt: topRow.createdAt,
    source: "sniper",
  } : null

  return {
    params: SNIPER_PARAMS,
    topCandidate,
    totalEvaluations: rows.length,
    resolvedCount: resolved.length,
    correctCount: correct,
    accuracy: resolved.length > 0 ? correct / resolved.length : 0,
    bySignalType: {
      sweep: { count: sweeps.length, correct: sweepCorrect, accuracy: sweeps.length > 0 ? sweepCorrect / sweeps.length : 0 },
      sigma: { count: sigmas.length, correct: sigmaCorrect, accuracy: sigmas.length > 0 ? sigmaCorrect / sigmas.length : 0 },
    },
    byDirection: {
      long: { count: longs.length, correct: longCorrect, accuracy: longs.length > 0 ? longCorrect / longs.length : 0 },
      short: { count: shorts.length, correct: shortCorrect, accuracy: shorts.length > 0 ? shortCorrect / shorts.length : 0 },
    },
    confidenceBuckets: {
      high: { count: high.length, correct: highCorrect, accuracy: high.length > 0 ? highCorrect / high.length : 0 },
      mid: { count: mid.length, correct: midCorrect, accuracy: mid.length > 0 ? midCorrect / mid.length : 0 },
      low: { count: low.length, correct: lowCorrect, accuracy: low.length > 0 ? lowCorrect / low.length : 0 },
    },
    rollingAccuracy: {
      last50: recent.length > 0 ? recentCorrect / recent.length : 0,
      allTime: resolved.length > 0 ? correct / resolved.length : 0,
    },
  }
}

// Stub to satisfy engine.ts import from Qwen Coder update
export async function maybeScanExchange(...args: any[]): Promise<any> {
  return null;
}

// Sniper scan cycle — mirrors runShadowCycle: iterates enabled grid configs,
// detects dislocations, records candidates, then resolves old decisions.
export interface SniperCandidate {
  symbol: string
  timeframe: string
  direction: "long" | "short"
  entry: number
  stopLoss: number
  takeProfit: number
  confidence: number
}

export async function runSniperCycle(): Promise<SniperCandidate[]> {
  // ── Decoupled universe: scan MEXC-wide for volatile movers, NOT grid pairs ──
  // The grid advisor deliberately picks low-volatility RANGING coins; a
  // liquidity-sweep / sigma-exhaustion sniper needs the opposite — trending,
  // high-volume movers. Rank the whole USDT-perp market by momentum and only
  // run the (expensive) kline fetch on the top candidates.
  const SCAN_LIMIT = 15 // top N movers per cycle

  // Read tunable sniper params from bot_config so the AI advisor can adjust
  // them at runtime. Fall back to SNIPER_PARAMS defaults if unset.
  let cfg: any = null
  try {
    const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1))
    cfg = rows[0] ?? null
  } catch {}
  const minVolumeUsdt = cfg?.sniperMinVolumeUsdt ?? SNIPER_PARAMS.minVolumeUsdt
  const sigmaExtreme = cfg?.sniperSigmaExtreme ?? SNIPER_PARAMS.sigmaExtreme
  const volumeSurgeMult = cfg?.sniperVolumeSurgeMult ?? SNIPER_PARAMS.volumeSurgeMult
  const minStopPct = cfg?.sniperMinStopPct ?? SNIPER_PARAMS.minStopPct
  const tpSlRatio = cfg?.sniperTpSlRatio ?? SNIPER_PARAMS.tpSlRatio

  let tickers: BulkTicker[]
  try {
    tickers = await fetchAllTickers()
  } catch (err) {
    console.error("[Sniper] bulk ticker fetch failed:", err)
    return []
  }

  // Rank by a momentum score: absolute 24h move weighted by volume, so we
  // surface coins that are both moving AND liquid (not dead micro-caps).
  // Hard liquidity floor: drop any coin whose 24h USDT notional is below the
  // threshold. Low-cap coins have thin books — a $20 order can whipsaw price
  // straight through a stop. `amount24` is the quote (USDT) notional, the
  // correct liquidity measure (base `volume24` is misleading for low-price coins).
  const ranked = tickers
    .filter((t) => t.amount24 >= minVolumeUsdt && t.lastPrice > 0)
    .map((t) => ({ ...t, score: Math.abs(t.riseFallRate) * Math.log10(t.amount24 + 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SCAN_LIMIT)

  const seen = new Set<string>()
  const fresh: SniperCandidate[] = []

  for (const t of ranked) {
    const symbol = t.symbol
    const timeframe = "Min5" // sniper operates on a fast timeframe
    const key = `${symbol}|${timeframe}`
    if (seen.has(key)) continue
    seen.add(key)

    const tfSec = tfSeconds(timeframe)
    const bucket = Math.floor(Date.now() / 1000 / tfSec)

    const dup = await db.select({ id: classifierDecisions.id }).from(classifierDecisions).where(
      and(
        eq(classifierDecisions.strategy, "sniper"),
        eq(classifierDecisions.symbol, symbol),
        eq(classifierDecisions.timeframe, timeframe),
        eq(classifierDecisions.candleTime, bucket),
      )
    )
    if (dup.length > 0) continue

    const candles = await fetchKlines(symbol, timeframe, 200).catch(() => null)
    if (!candles || candles.length < 60) continue

    // Build minimal snapshot with inline ATR (detectSniper only needs snap.atr
    // for the short-side ATR stop buffer). Avoids needing a full BotConfig here.
    const _cl = candles as Candle[]
    let _trSum = 0
    for (let _i = _cl.length - 14; _i < _cl.length; _i++) {
      _trSum += Math.max(
        _cl[_i].high - _cl[_i].low,
        Math.abs(_cl[_i].high - _cl[_i - 1].close),
        Math.abs(_cl[_i].low - _cl[_i - 1].close)
      )
    }
    const snap = { atr: _trSum / 14, price: _cl[_cl.length - 1].close } as IndicatorSnapshot

    console.log(`[Sniper] Running detectSniper on ${symbol}... (atr=${snap.atr})`);
    const sig = detectSniper(_cl, snap, t.fundingRate, { sigmaExtreme, volumeSurgeMult })
    if (!sig.direction) {
      console.log(`[Sniper] ${symbol}: no signal (confidence too low or no valid setup)`);
      continue;
    }

    if (sig.reason.includes("funding")) {
      try {
        await db.insert(botLogs).values({ level: "info", message: `Sniper: funding edge on ${symbol} (rate ${(sig.fundingRate * 100).toFixed(4)}%, ${sig.direction === "long" ? "crowded shorts" : "crowded longs"})` })
      } catch { /* best-effort */ }
    }

    const entryPrice = _cl[_cl.length - 1].close
    const entryTime = _cl[_cl.length - 1].time
    await recordSniperCandidate(symbol, timeframe, bucket, entryPrice, sig, entryTime)
      console.log(`[Sniper] ${symbol}: candidate recorded in database, bucket=${bucket}`);
    fresh.push({ symbol, timeframe, direction: sig.direction, entry: entryPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, confidence: sig.confidence })
  }

  await resolveSniperDecisions()
  console.log(`[Sniper] resolveSniperDecisions completed`);
  return fresh
}

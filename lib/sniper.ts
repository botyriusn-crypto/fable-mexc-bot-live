import type { Candle } from "./mexc/public"
import type { IndicatorSnapshot } from "./indicators"
import { db } from "./db"
import { classifierDecisions, gridConfigs } from "./db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { fetchTicker, fetchKlines } from "./mexc/public"
import { recordOutcome, type SniperFeatures } from "./advisor"

export const SNIPER_LIVE = false // Stage 2: flip to true after observe baseline proves hit-rate

// Tunable rule parameters (Option A: exposed for display + advisor tuning).
export const SNIPER_PARAMS = {
  sweepLookback: 20,
  volumeSurgeMult: 2.0,
  sigmaExtreme: 2.5,
  fundingThreshold: 0.0005,
  tpSlRatio: 3,
  resolveAfterBuckets: 6,
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

export function detectSniper(candles: Candle[], snap: IndicatorSnapshot, fundingRate = 0): SniperSignal {
  const none: SniperSignal = { direction: null, reason: "no dislocation", confidence: 0, stopLoss: 0, takeProfit: 0, signalType: null, volSurge: 0, z: 0, fundingRate }
  if (candles.length < 60) return none

  const last = candles[candles.length - 1]
  const prev = candles.slice(-SWEEP_LOOKBACK - 1, -1)
  const swingLow = Math.min(...prev.map(c => c.low))
  const swingHigh = Math.max(...prev.map(c => c.high))
  const avgVol = avg(prev.map(c => c.volume))
  const volSurge = avgVol > 0 ? last.volume / avgVol : 1

  const bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= VOLUME_SURGE_MULT
  const bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && volSurge >= VOLUME_SURGE_MULT

  const closes = candles.map(c => c.close)
  const window = closes.slice(-100)
  const mean = avg(window)
  const sd = Math.sqrt(avg(window.map(c => (c - mean) ** 2))) || 1
  const z = (last.close - mean) / sd
  const exhaustedDown = z < -SIGMA_EXTREME && last.close > last.open
  const exhaustedUp = z > SIGMA_EXTREME && last.close < last.open

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
    direction = "long"; confidence = 0.65
    reason = `Sigma exhaustion: z=${z.toFixed(1)} crash w/ bullish reversal candle`; extreme = last.low; signalType = "sigma"
  } else if (exhaustedUp) {
    direction = "short"; confidence = 0.65
    reason = `Sigma exhaustion: z=${z.toFixed(1)} blow-off w/ bearish reversal candle`; extreme = last.high; signalType = "sigma"
  }

  if (!direction) return none

  if (direction === "short" && fundingRate > SNIPER_PARAMS.fundingThreshold) { confidence += 0.1; reason += " + crowded longs (funding)" }
  if (direction === "long" && fundingRate < -SNIPER_PARAMS.fundingThreshold) { confidence += 0.1; reason += " + crowded shorts (funding)" }

  const entry = last.close
  const stopLoss = direction === "long" ? Math.min(extreme, last.low) * 0.998 : Math.max(extreme, last.high) * 1.002
  const risk = Math.abs(entry - stopLoss)
  if (risk <= 0) return none
  const takeProfit = direction === "long" ? entry + risk * SNIPER_PARAMS.tpSlRatio : entry - risk * SNIPER_PARAMS.tpSlRatio

  return { direction, reason, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit, signalType, volSurge, z, fundingRate }
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal) {
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
      lorentzianFilters: { signalType: sig.signalType, volSurge: sig.volSurge, z: sig.z, fundingRate: sig.fundingRate },
      finalAllowed: true,
      reason: sig.reason,
    }).onConflictDoNothing()
  } catch (err) {}
}

function tfSeconds(tf: string): number {
  const m = /Min(\d+)/.exec(tf)
  return m ? parseInt(m[1], 10) * 60 : 300
}

// Resolve sniper candidates after N buckets, mirroring the shadow resolver.
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

    // Feed the advisor so variants grade this outcome counterfactually.
    const sig = (d.lorentzianFilters ?? null) as any as SniperFeatures | null
    if (sig) {
      await recordOutcome(sig, d.candidateDirection, d.logisticConfidence, correct, ret).catch(() => {})
    }
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
  const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
  const seen = new Set<string>()
  const fresh: SniperCandidate[] = []

  for (const cfg of configs) {
    const key = `${cfg.symbol}|${cfg.timeframe}`
    if (seen.has(key)) continue
    seen.add(key)

    const tfSec = tfSeconds(cfg.timeframe)
    const bucket = Math.floor(Date.now() / 1000 / tfSec)

    const dup = await db.select({ id: classifierDecisions.id }).from(classifierDecisions).where(
      and(
        eq(classifierDecisions.strategy, "sniper"),
        eq(classifierDecisions.symbol, cfg.symbol),
        eq(classifierDecisions.timeframe, cfg.timeframe),
        eq(classifierDecisions.candleTime, bucket),
      )
    )
    if (dup.length > 0) continue

    const [ticker, candles] = await Promise.all([
      fetchTicker(cfg.symbol).catch(() => null),
      fetchKlines(cfg.symbol, cfg.timeframe, 200).catch(() => null),
    ])
    if (!ticker?.lastPrice || !candles || candles.length < 60) continue

    const sig = detectSniper(candles as Candle[], {} as IndicatorSnapshot, 0)
    if (!sig.direction) continue

    await recordSniperCandidate(cfg.symbol, cfg.timeframe, bucket, ticker.lastPrice, sig)
    fresh.push({ symbol: cfg.symbol, timeframe: cfg.timeframe, direction: sig.direction, entry: ticker.lastPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, confidence: sig.confidence })
  }

  await resolveSniperDecisions()
  return fresh
}

// Shadow Entry Evaluator — generates SNIPER-relevant training data without placing orders.
import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "./db"
import { classifierDecisions, gridOrders } from "./db/schema"
import { loadModelById, predict, trainShadowOnDecision } from "./ml"
import { fetchTicker } from "./mexc/public"
import type { FeatureVector } from "./indicators"

const RESOLVE_AFTER_BUCKETS = 6

const tfSeconds = (tf: string) => {
  const m = /Min(\d+)/.exec(tf)
  return m ? parseInt(m[1], 10) * 60 : 300
}

export async function runShadowCycle(): Promise<void> {
  let model = await loadModelById(2)

  // 1) Reuse real features already stored on pending grid orders
  const pending = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
  const seen = new Set<string>()
  const candidates: { symbol: string; timeframe: string; features: FeatureVector }[] = []
  for (const o of pending) {
    const key = `${o.symbol}|${o.timeframe}`
    if (seen.has(key)) continue
    seen.add(key)
    const f = (o as any).entryFeatures as FeatureVector | null
    if (!f || typeof f !== "object") continue
    candidates.push({ symbol: o.symbol, timeframe: o.timeframe, features: f })
  }

  // 2) Evaluate long & short, log the stronger direction once per candle bucket
  for (const c of candidates) {
    const tfSec = tfSeconds(c.timeframe)
    const bucket = Math.floor(Date.now() / 1000 / tfSec)
    const dup = await db.select({ id: classifierDecisions.id }).from(classifierDecisions).where(
      and(
        eq(classifierDecisions.strategy, "shadow"),
        eq(classifierDecisions.symbol, c.symbol),
        eq(classifierDecisions.timeframe, c.timeframe),
        eq(classifierDecisions.candleTime, bucket),
      )
    )
    if (dup.length > 0) continue

    const longConf = predict(model, { ...c.features, sideLong: 1 } as FeatureVector)
    const shortConf = predict(model, { ...c.features, sideLong: 0 } as FeatureVector)
    const dir = longConf >= shortConf ? "long" : "short"
    const conf = Math.max(longConf, shortConf)

    const ticker: any = await fetchTicker(c.symbol).catch(() => null)
    const price = ticker?.lastPrice ?? ticker?.price ?? 0
    if (!price) continue

    await db.insert(classifierDecisions).values({
      symbol: c.symbol,
      timeframe: c.timeframe,
      candleTime: bucket,
      candidateDirection: dir,
      strategy: "shadow",
      regime: "shadow",
      entryPrice: price,
      confirmationMode: "shadow",
      logisticAllowed: false,
      logisticConfidence: conf,
      lorentzianDirection: dir,
      lorentzianVote: 0,
      lorentzianConfidence: 0,
      lorentzianAllowed: false,
      lorentzianFilters: c.features as any,
      finalAllowed: false,
      reason: `shadow eval: ${dir} conf ${(conf * 100).toFixed(1)}%`,
    })
  }

  // 3) Resolve shadow decisions older than N buckets, then train model id=2
  const unresolved = await db.select().from(classifierDecisions).where(
    and(eq(classifierDecisions.strategy, "shadow"), isNull(classifierDecisions.resolvedAt))
  )
  for (const d of unresolved) {
    const tfSec = tfSeconds(d.timeframe)
    const curBucket = Math.floor(Date.now() / 1000 / tfSec)
    if (curBucket - d.candleTime < RESOLVE_AFTER_BUCKETS) continue
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

    const f = d.lorentzianFilters as any as FeatureVector
    if (f) {
      const feat = { ...f, sideLong: d.candidateDirection === "long" ? 1 : 0 } as FeatureVector
      model = await trainShadowOnDecision(model, feat, d.candidateDirection as any, actual, ret, 0.02, d.id)
    }
  }
}

export async function getShadowStats() {
  const rows = await db.select().from(classifierDecisions)
    .where(eq(classifierDecisions.strategy, "shadow"))
    .orderBy(sql`created_at DESC`)
    .limit(500)
  const resolved = rows.filter(d => d.resolvedAt)
  const correct = resolved.filter(d => d.outcomeCorrectLogistic).length
  const unresolved = rows.filter(d => !d.resolvedAt)
    .sort((a, b) => Math.abs(b.logisticConfidence - 0.5) - Math.abs(a.logisticConfidence - 0.5))
  return {
    totalEvaluations: rows.length,
    resolvedCount: resolved.length,
    correctCount: correct,
    accuracy: resolved.length > 0 ? correct / resolved.length : 0,
    topCandidate: unresolved.length > 0 ? {
      symbol: unresolved[0].symbol,
      direction: unresolved[0].candidateDirection,
      confidence: unresolved[0].logisticConfidence,
    } : null,
  }
}

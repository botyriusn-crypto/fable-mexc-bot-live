// Shadow Entry Evaluator — generates SNIPER-relevant training data without placing orders.
// Computes features on the fly from current klines (not stale stored ones).
import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "./db"
import { classifierDecisions, gridConfigs } from "./db/schema"
import { loadModelById, predict, trainShadowOnDecision, MODEL_IDS } from "./ml"
import { heuristicScore } from "./advisor"
import { fetchTicker, fetchKlines } from "./mexc/public"
import { ema, rsi, macdHistogram, atr, rateOfChange, adx, volumeSurge } from "./indicators"
import type { FeatureVector } from "./indicators"

const RESOLVE_AFTER_BUCKETS = 6

const tfSeconds = (tf: string) => {
  const m = /Min(\d+)/.exec(tf)
  return m ? parseInt(m[1], 10) * 60 : 300
}

async function computeLiveFeatures(symbol: string, timeframe: string): Promise<{ features: FeatureVector; price: number } | null> {
  try {
    const [ticker, candles] = await Promise.all([
      fetchTicker(symbol),
      fetchKlines(symbol, timeframe, 200),
    ])
    if (!ticker?.lastPrice || candles.length < 50) return null

    const closes = candles.map((c: any) => c.close)
    const currentPrice = closes[closes.length - 1]
    
    const emaF = ema(closes, 12)
    const emaS = ema(closes, 26)
    const rsiArr = rsi(closes, 14)
    const macdHistArr = macdHistogram(closes)
    const atrArr = atr(candles, 14)
    const adxArr = adx(candles, 14)
    const rocArr = rateOfChange(closes, 10)
    const volSurgeArr = volumeSurge(candles, 20)

    const emaFastVal = emaF[emaF.length - 1]
    const emaSlowVal = emaS[emaS.length - 1]
    const rsiVal = rsiArr[rsiArr.length - 1]
    const macdHistVal = macdHistArr[macdHistArr.length - 1]
    const atrVal = atrArr[atrArr.length - 1]
    const adxVal = adxArr[adxArr.length - 1]
    const rocVal = rocArr[rocArr.length - 1]
    const volSurgeVal = volSurgeArr[volSurgeArr.length - 1]

    const atrPct = Math.min(atrVal / currentPrice, 0.2)

    const features: FeatureVector = {
      emaSpread: (emaFastVal - emaSlowVal) / currentPrice,
      crossover: emaFastVal > emaSlowVal ? 1 : 0,
      rsi: rsiVal / 100,
      macdHist: macdHistVal / currentPrice,
      atrPct,
      roc: rocVal / 100,
      adx: adxVal / 100,
      volSurge: volSurgeVal / 100,
      sideLong: 1,
    }
    return { features, price: ticker.lastPrice }
  } catch (err) {
    return null
  }
}

export async function runShadowCycle(): Promise<void> {
  // Shadow uses its OWN model row so its timing experiments never overwrite the
  // live grid model (id=1).
  let model = await loadModelById(MODEL_IDS.shadow)

  // 1) Iterate enabled grid configs (one evaluation per symbol per candle bucket)
  const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
  const seen = new Set<string>()

  for (const cfg of configs) {
    const key = `${cfg.symbol}|${cfg.timeframe}`
    if (seen.has(key)) continue
    seen.add(key)

    const live = await computeLiveFeatures(cfg.symbol, cfg.timeframe)
    if (!live) continue

    const tfSec = tfSeconds(cfg.timeframe)
    const bucket = Math.floor(Date.now() / 1000 / tfSec)
    const dup = await db.select({ id: classifierDecisions.id }).from(classifierDecisions).where(
      and(
        eq(classifierDecisions.strategy, "shadow"),
        eq(classifierDecisions.symbol, cfg.symbol),
        eq(classifierDecisions.timeframe, cfg.timeframe),
        eq(classifierDecisions.candleTime, bucket),
      )
    )
    if (dup.length > 0) continue

    const longConf = predict(model, { ...live.features, sideLong: 1 } as FeatureVector)
    const shortConf = predict(model, { ...live.features, sideLong: 0 } as FeatureVector)
    const dir = longConf >= shortConf ? "long" : "short"
    const conf = Math.max(longConf, shortConf)

    await db.insert(classifierDecisions).values({
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      candleTime: bucket,
      candidateDirection: dir,
      strategy: "shadow",
      regime: "shadow",
      entryPrice: live.price,
      confirmationMode: "shadow",
      logisticAllowed: false,
      logisticConfidence: conf,
      lorentzianDirection: dir,
      lorentzianVote: 0,
      lorentzianConfidence: 0,
      lorentzianAllowed: false,
      lorentzianFilters: live.features as any,
      finalAllowed: false,
      reason: `shadow eval: ${dir} conf ${(conf * 100).toFixed(1)}%`,
    })
  }

  // 2) Resolve old decisions, then train model id=2
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
      returnUnit: "percent",
      outcomeCorrectLogistic: correct,
      outcomeCorrectLorentzian: correct,
      resolvedAt: sql`NOW()`,
    }).where(eq(classifierDecisions.id, d.id))

    const f = d.lorentzianFilters as any as FeatureVector
    if (f) {
      const feat = { ...f, sideLong: d.candidateDirection === "long" ? 1 : 0 } as FeatureVector
      model = await trainShadowOnDecision(model, feat, d.candidateDirection as any, actual, ret, 0.02, d.id, MODEL_IDS.shadow)
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
  
  // Load current shadow model to recompute honest real-time confidence
  const model = await loadModelById(MODEL_IDS.shadow)
  
  const scored = unresolved.map(d => {
    const f = (d.lorentzianFilters ?? {}) as any as FeatureVector
    // Recompute ML confidence with CURRENT weights (honest real-time read)
    const longConf = predict(model, { ...f, sideLong: 1 } as FeatureVector)
    const shortConf = predict(model, { ...f, sideLong: 0 } as FeatureVector)
    const ml = Math.max(longConf, shortConf)
    
    const setup = heuristicScore(f, d.candidateDirection)
    const mlSignal = Math.abs(ml - 0.5)
    const setupSignal = Math.abs(setup - 0.5)
    const source = mlSignal > setupSignal ? "ml" : "setup"
    
    return { symbol: d.symbol, direction: d.candidateDirection, confidence: Math.max(ml, setup), source, createdAt: d.createdAt?.toISOString?.() ?? new Date().toISOString() }
  }).sort((a, b) => Math.abs(b.confidence - 0.5) - Math.abs(a.confidence - 0.5))
  
  // --- TIER 3 ANALYTICS ---
  // 1. Confidence buckets
  const highConf = resolved.filter(d => d.logisticConfidence >= 0.70)
  const midConf = resolved.filter(d => d.logisticConfidence >= 0.55 && d.logisticConfidence < 0.70)
  const lowConf = resolved.filter(d => d.logisticConfidence < 0.55)
  
  const highCorrect = highConf.filter(d => d.outcomeCorrectLogistic).length
  const midCorrect = midConf.filter(d => d.outcomeCorrectLogistic).length
  const lowCorrect = lowConf.filter(d => d.outcomeCorrectLogistic).length
  
  // 2. Side splits (Long vs Short)
  const longDecisions = resolved.filter(d => d.candidateDirection === 'long')
  const shortDecisions = resolved.filter(d => d.candidateDirection === 'short')
  const longCorrect = longDecisions.filter(d => d.outcomeCorrectLogistic).length
  const shortCorrect = shortDecisions.filter(d => d.outcomeCorrectLogistic).length
  
  // 3. Rolling accuracy (last 50 resolved, ordered by resolvedAt)
  const recentResolved = resolved
    .filter(d => d.resolvedAt)
    .sort((a, b) => new Date(b.resolvedAt as any).getTime() - new Date(a.resolvedAt as any).getTime())
    .slice(0, 50)
  const recentCorrect = recentResolved.filter(d => d.outcomeCorrectLogistic).length

  return {
    totalEvaluations: rows.length,
    resolvedCount: resolved.length,
    correctCount: correct,
    accuracy: resolved.length > 0 ? correct / resolved.length : 0,
    topCandidate: scored[0] ?? null,
    
    // New Tier 3 Analytics payload
    confidenceBuckets: {
      high: { count: highConf.length, correct: highCorrect, accuracy: highConf.length > 0 ? highCorrect / highConf.length : 0 },
      mid: { count: midConf.length, correct: midCorrect, accuracy: midConf.length > 0 ? midCorrect / midConf.length : 0 },
      low: { count: lowConf.length, correct: lowCorrect, accuracy: lowConf.length > 0 ? lowCorrect / lowConf.length : 0 },
    },
    sideSplits: {
      long: { count: longDecisions.length, correct: longCorrect, accuracy: longDecisions.length > 0 ? longCorrect / longDecisions.length : 0 },
      short: { count: shortDecisions.length, correct: shortCorrect, accuracy: shortDecisions.length > 0 ? shortCorrect / shortDecisions.length : 0 },
    },
    rollingAccuracy: {
      last50: recentResolved.length > 0 ? recentCorrect / recentResolved.length : 0,
      allTime: resolved.length > 0 ? correct / resolved.length : 0,
    },
  }
}

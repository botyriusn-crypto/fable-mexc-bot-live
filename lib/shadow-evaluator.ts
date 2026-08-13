// Shadow Entry Evaluator — generates SNIPER-relevant training data without placing orders.
// Computes features on the fly from current klines (not stale stored ones).
import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "./db"
import { classifierDecisions, gridConfigs } from "./db/schema"
import { loadModelById, predict, trainShadowOnDecision } from "./ml"
import { recordOutcome } from "./advisor"
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
  let model = await loadModelById(1)

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
      outcomeCorrectLogistic: correct,
      outcomeCorrectLorentzian: correct,
      resolvedAt: sql`NOW()`,
    }).where(eq(classifierDecisions.id, d.id))

    const f = d.lorentzianFilters as any as FeatureVector
    if (f) {
      await recordOutcome(f, d.candidateDirection, d.logisticConfidence, correct, ret).catch(() => {})
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

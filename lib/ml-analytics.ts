// lib/ml-analytics.ts
// Per-model confidence-bucketed performance tracking.
//
// The mlModel table tracks aggregate rollingAccuracy, but that doesn't tell
// us whether the confidence score is actually predictive. A well-calibrated
// model should show monotonically increasing hit rate as confidence bucket
// rises. If it doesn't, the confidence score is decorative, not predictive.

import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { sql } from "drizzle-orm"

export interface ConfidenceBucketStats {
  bucket: string // e.g. "0.50-0.60"
  total: number
  resolved: number
  correct: number
  hitRate: number | null
  avgReturn: number | null
}

export interface ModelAnalytics {
  model: string
  buckets: ConfidenceBucketStats[]
  overallHitRate: number | null
  overallAvgReturn: number | null
  sampleCount: number
}

// Compute hit rate per confidence bucket for a given model type.
// modelType: "logistic" | "lorentzian"
export async function getConfidenceBucketedStats(modelType: "logistic" | "lorentzian"): Promise<ModelAnalytics> {
  const confidenceCol = modelType === "logistic" 
    ? classifierDecisions.logisticConfidence 
    : classifierDecisions.lorentzianConfidence
  const correctCol = modelType === "logistic"
    ? classifierDecisions.outcomeCorrectLogistic
    : classifierDecisions.outcomeCorrectLorentzian

  const rows = await db
    .select({
      confidence: confidenceCol,
      correct: correctCol,
      return: classifierDecisions.outcomeReturn,
    })
    .from(classifierDecisions)
    .where(sql`${classifierDecisions.resolvedAt} IS NOT NULL`)

  const buckets: ConfidenceBucketStats[] = []
  const bucketDefs = [
    { label: "0.50-0.60", min: 0.50, max: 0.60 },
    { label: "0.60-0.70", min: 0.60, max: 0.70 },
    { label: "0.70-0.80", min: 0.70, max: 0.80 },
    { label: "0.80-0.90", min: 0.80, max: 0.90 },
    { label: "0.90-1.00", min: 0.90, max: 1.00 },
  ]

  for (const def of bucketDefs) {
    const inBucket = rows.filter(r => {
      const c = Number(r.confidence)
      return c >= def.min && c < def.max
    })
    const resolved = inBucket.filter(r => r.correct !== null && r.correct !== undefined)
    const correct = resolved.filter(r => r.correct === true).length
    const returns = resolved.map(r => Number(r.return)).filter(r => isFinite(r))
    
    buckets.push({
      bucket: def.label,
      total: inBucket.length,
      resolved: resolved.length,
      correct,
      hitRate: resolved.length > 0 ? correct / resolved.length : null,
      avgReturn: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
    })
  }

  const allResolved = rows.filter(r => r.correct !== null && r.correct !== undefined)
  const allCorrect = allResolved.filter(r => r.correct === true).length
  const allReturns = allResolved.map(r => Number(r.return)).filter(r => isFinite(r))

  return {
    model: modelType,
    buckets,
    overallHitRate: allResolved.length > 0 ? allCorrect / allResolved.length : null,
    overallAvgReturn: allReturns.length > 0 ? allReturns.reduce((a, b) => a + b, 0) / allReturns.length : null,
    sampleCount: allResolved.length,
  }
}

// Funnel: signals → passed ML → passed Lorentzian → filled
// Tells us how much attrition each gate is causing.
export async function getSignalFunnel(): Promise<{
  totalSignals: number
  passedLogistic: number
  passedLorentzian: number
  passedBoth: number
  finalAllowed: number
  logisticOnlyRejectPct: number
  lorentzianOnlyRejectPct: number
  bothRejectPct: number
}> {
  const rows = await db
    .select({
      logisticAllowed: classifierDecisions.logisticAllowed,
      lorentzianAllowed: classifierDecisions.lorentzianAllowed,
      finalAllowed: classifierDecisions.finalAllowed,
    })
    .from(classifierDecisions)

  const total = rows.length
  const passedLogistic = rows.filter(r => r.logisticAllowed).length
  const passedLorentzian = rows.filter(r => r.lorentzianAllowed).length
  const passedBoth = rows.filter(r => r.logisticAllowed && r.lorentzianAllowed).length
  const finalAllowed = rows.filter(r => r.finalAllowed).length

  return {
    totalSignals: total,
    passedLogistic,
    passedLorentzian,
    passedBoth,
    finalAllowed,
    logisticOnlyRejectPct: total > 0 ? (total - passedLogistic) / total : 0,
    lorentzianOnlyRejectPct: total > 0 ? (total - passedLorentzian) / total : 0,
    bothRejectPct: total > 0 ? (total - passedBoth) / total : 0,
  }
}

// Redundancy check: how often do ML and Lorentzian agree/reject the same trade?
// High agreement rate on REJECTIONS means they're redundant (rejecting same trades).
export async function getGateRedundancy(): Promise<{
  logisticRejectLorentzianReject: number
  logisticRejectLorentzianAllow: number
  logisticAllowLorentzianReject: number
  logisticAllowLorentzianAllow: number
  kappa: number // Cohen's kappa: 1 = perfect agreement, 0 = chance, <0 = disagreement
}> {
  const rows = await db
    .select({
      logisticAllowed: classifierDecisions.logisticAllowed,
      lorentzianAllowed: classifierDecisions.lorentzianAllowed,
    })
    .from(classifierDecisions)

  let rr = 0, ra = 0, ar = 0, aa = 0
  for (const r of rows) {
    const l = r.logisticAllowed
    const z = r.lorentzianAllowed
    if (!l && !z) rr++
    else if (!l && z) ra++
    else if (l && !z) ar++
    else aa++
  }
  const total = rr + ra + ar + aa
  const pAgree = total > 0 ? (rr + aa) / total : 0
  const pRejectLogistic = total > 0 ? (rr + ra) / total : 0
  const pRejectLorentzian = total > 0 ? (rr + ar) / total : 0
  const pChance = pRejectLogistic * pRejectLorentzian + (1 - pRejectLogistic) * (1 - pRejectLorentzian)
  const kappa = total > 0 ? (pAgree - pChance) / (1 - pChance) : 0

  return {
    logisticRejectLorentzianReject: rr,
    logisticRejectLorentzianAllow: ra,
    logisticAllowLorentzianReject: ar,
    logisticAllowLorentzianAllow: aa,
    kappa,
  }
}

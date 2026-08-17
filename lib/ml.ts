// Online logistic regression — learns from every closed trade.
// Mode separation: trend trades train the trend model, grid trades train separately.

import { db } from "./db"
import { mlModel, tradeFeatures } from "./db/schema"
import { eq, sql } from "drizzle-orm"
import type { FeatureVector } from "./indicators"

export const FEATURE_KEYS: (keyof FeatureVector)[] = [
  "emaSpread",
  "crossover",
  "rsi",
  "macdHist",
  "atrPct",
  "roc",
  "adx",
  "volSurge",
  "sideLong",
]
const MODEL_GEN = 2

// Separate model rows per learner so each learns its OWN edge. Grid trading is
// mean-reverting (buy dips, sell rips) while trend/scalp entries are momentum
// (buy strength, sell weakness) — their feature→outcome relationships are often
// OPPOSITE, so training them into one shared model (the previous behaviour) had
// each half constantly undoing the other's learning ("data poisoning"). Keeping
// id=1 as the grid model preserves whatever the currently-working grid has
// already learned; the others start cold and ramp up via gateEntry's cold-start
// relaxation. All ids are env-overridable.
export const MODEL_IDS = {
  grid: Number(process.env.ML_MODEL_ID_GRID) || 1,
  trend: Number(process.env.ML_MODEL_ID_TREND) || 2,
  scalp: Number(process.env.ML_MODEL_ID_SCALP) || 3,
  shadow: Number(process.env.ML_MODEL_ID_SHADOW) || 4,
} as const

export type ModelStrategy = keyof typeof MODEL_IDS

export interface MlState {
  weights: Record<string, number>
  bias: number
  sampleCount: number
  correctCount: number
  rollingAccuracy: number
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

// Extract real order id from MEXC response. Never return "[object Object]".
export function extractOrderId(res: any): string | null {
  const d = res?.data ?? res
  if (d == null) return null
  if (typeof d === "object") {
    const id = d.orderId ?? d.order_id ?? d.id
    return id != null ? String(id) : null
  }
  return String(d)
}

// Surface real Postgres error reason (normally discarded by Drizzle).
export function dbErr(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause
    const detail = cause?.detail ?? cause?.message ?? cause?.code
    return detail ? `${err.message} | cause: ${detail}` : err.message
  }
  return String(err)
}

// Validate features are sane (not NaN, in reasonable range).
export function validateFeatures(features: Record<string, number>): { valid: boolean; reason?: string } {
  for (const name of FEATURE_KEYS) {
    const v = features[name]
    if (v == null || !isFinite(v)) {
      return { valid: false, reason: `${name} is NaN or infinite` }
    }
    if (Math.abs(v) > 100) {
      return { valid: false, reason: `${name} = ${v} is out of sane range` }
    }
  }
  return { valid: true }
}

export async function loadModel(): Promise<MlState> {
  const rows = await db.select().from(mlModel).where(eq(mlModel.id, 1))
  if (rows.length === 0) {
    const weights = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0]))
    await db.insert(mlModel).values({ id: 1, weights }).onConflictDoNothing()
    return { weights, bias: 0, sampleCount: 0, correctCount: 0, rollingAccuracy: 0.5 }
  }
  const r = rows[0]
  return {
    weights: r.weights,
    bias: r.bias,
    sampleCount: r.sampleCount,
    correctCount: r.correctCount,
    rollingAccuracy: r.rollingAccuracy,
  }
}

// Probability that this entry will be profitable.
export function predict(model: MlState, features: FeatureVector): number {
  let z = model.bias
  for (const key of FEATURE_KEYS) {
    z += (model.weights[key] ?? 0) * (features[key] ?? 0)
  }
  return sigmoid(z)
}

// Confidence gate: cold-start neutral (defers to indicators), tightens with samples.
// Returns { allowed, confidence } — while sampleCount is low the effective
// threshold is relaxed toward 0.5 so the model can gather data.
export function gateEntry(
  model: MlState,
  features: FeatureVector,
  configuredThreshold: number,
): { allowed: boolean; confidence: number } {
  const confidence = predict(model, features)
  const rampSamples = 30
  const ramp = Math.min(model.sampleCount / rampSamples, 1)
  const effectiveThreshold = 0.5 + (configuredThreshold - 0.5) * ramp
  return { allowed: confidence >= effectiveThreshold, confidence }
}

// SGD update from a closed trade. label: 1 = win, 0 = loss.
// pnlWeight scales the gradient by PnL magnitude (bigger wins/losses teach more).
// NEW: tradeMode parameter separates grid vs trend learning (optional for backward compat).


// Load model by ID (id=1 is grid model, id=2 is shadow/timing model)
export async function loadModelById(id: number): Promise<MlState> {
  const rows = await db.select().from(mlModel).where(eq(mlModel.id, id))
  if (rows.length === 0) {
    const weights = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0]))
    await db.insert(mlModel).values({ id, weights }).onConflictDoNothing()
    return { weights, bias: 0, sampleCount: 0, correctCount: 0, rollingAccuracy: 0.5 }
  }
  const r = rows[0]
  return {
    weights: r.weights,
    bias: r.bias,
    sampleCount: r.sampleCount,
    correctCount: r.correctCount,
    rollingAccuracy: r.rollingAccuracy,
  }
}

// Load the dedicated model for a given strategy ("grid" | "trend" | "scalp" | "shadow").
export async function loadModelFor(strategy: ModelStrategy): Promise<MlState> {
  return loadModelById(MODEL_IDS[strategy])
}

// Shadow evaluation: predict without placing orders
export function shadowPredict(model: MlState, features: FeatureVector): number {
  return predict(model, features)
}

// Train shadow model on resolved decisions
export async function trainShadowOnDecision(
  model: MlState,
  features: FeatureVector,
  predictedDirection: "long" | "short",
  actualDirection: "long" | "short" | "neutral",
  outcomeReturn: number,
  learningRate: number,
  decisionId: number,
  modelId: number = MODEL_IDS.shadow,
): Promise<MlState> {
  const label = predictedDirection === actualDirection ? 1 : 0
  
  const prediction = predict(model, features)
  const error = prediction - label
  
  const lr = learningRate
  
  const newWeights: Record<string, number> = { ...model.weights }
  for (const key of FEATURE_KEYS) {
    const grad = error * (features[key] ?? 0)
    newWeights[key] = (newWeights[key] ?? 0) - lr * grad - lr * 0.02 * (newWeights[key] ?? 0)
  }
  const newBias = model.bias - lr * error
  
  const predictedWin = prediction >= 0.5
  const correct = predictedWin === (label === 1)
  const newSampleCount = model.sampleCount + 1
  const newCorrectCount = model.correctCount + (correct ? 1 : 0)
  const newRollingAccuracy =
    model.sampleCount === 0
      ? correct ? 1 : 0
      : model.rollingAccuracy * 0.9 + (correct ? 1 : 0) * 0.1
  
  await db
    .update(mlModel)
    .set({
      weights: newWeights,
      bias: newBias,
      sampleCount: newSampleCount,
      correctCount: newCorrectCount,
      rollingAccuracy: newRollingAccuracy,
      updatedAt: sql`NOW()`,
    })
    .where(eq(mlModel.id, modelId))
  
  return {
    weights: newWeights,
    bias: newBias,
    sampleCount: newSampleCount,
    correctCount: newCorrectCount,
    rollingAccuracy: newRollingAccuracy,
  }
}

export async function trainOnTrade(
  model: MlState,
  features: FeatureVector,
  won: boolean,
  pnlPct: number,
  learningRate: number,
  tradeId: number,
  positionId: number | null,
  modelId: number = MODEL_IDS.grid,
): Promise<MlState> {
  const label = won ? 1 : 0
  // Data-poisoning is now prevented structurally: each strategy trains its OWN
  // model row (see MODEL_IDS), so there is no need to DROP off-mode trades — a
  // drop would just throw away hard-won, real outcome data. The caller selects
  // the correct model via `modelId`.

  const prediction = predict(model, features)
  const error = prediction - label
  // Softened from a 3x cap: a single very large loss/win could otherwise
  // apply a gradient step big enough to bias most subsequent predictions for
  // a long stretch, especially since real market features are autocorrelated
  // (a given regime persists across many consecutive candles).
  const pnlWeight = Math.min(1 + Math.abs(pnlPct) / 2, 1.5) // cap at 1.5x
  const lr = learningRate * pnlWeight

  const newWeights: Record<string, number> = { ...model.weights }
  for (const key of FEATURE_KEYS) {
    const grad = error * (features[key] ?? 0)
    // L2 regularization (strengthened from 0.01) pulls weights back toward
    // neutral faster between updates, so a small handful of early samples
    // can't leave a lasting bias before the model has real breadth of data.
    newWeights[key] = (newWeights[key] ?? 0) - lr * grad - lr * 0.03 * (newWeights[key] ?? 0)
  }
  const newBias = model.bias - lr * error

  // Track whether the model's prediction agreed with the outcome
  const predictedWin = prediction >= 0.5
  const correct = predictedWin === won
  const newSampleCount = model.sampleCount + 1
  const newCorrectCount = model.correctCount + (correct ? 1 : 0)
  // Exponential rolling accuracy (alpha=0.1)
  const newRollingAccuracy =
    model.sampleCount === 0
      ? correct
        ? 1
        : 0
      : model.rollingAccuracy * 0.9 + (correct ? 1 : 0) * 0.1

  await db
    .update(mlModel)
    .set({
      weights: newWeights,
      bias: newBias,
      sampleCount: newSampleCount,
      correctCount: newCorrectCount,
      rollingAccuracy: newRollingAccuracy,
      updatedAt: sql`NOW()`,
    })
    .where(eq(mlModel.id, modelId))

  await db.insert(tradeFeatures).values({
    tradeId,
    positionId,
    features: features as unknown as Record<string, number>,
    label,
  })

  return {
    weights: newWeights,
    bias: newBias,
    sampleCount: newSampleCount,
    correctCount: newCorrectCount,
    rollingAccuracy: newRollingAccuracy,
  }
}

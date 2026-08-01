// Online logistic regression — learns from every closed trade.

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

export interface MlState {
  weights: Record<string, number>
  bias: number
  sampleCount: number
  correctCount: number
  rollingAccuracy: number
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

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
export async function trainOnTrade(
  model: MlState,
  features: FeatureVector,
  won: boolean,
  pnlPct: number,
  learningRate: number,
  tradeId: number,
  positionId: number | null,
): Promise<MlState> {
  const label = won ? 1 : 0
  const prediction = predict(model, features)
  const error = prediction - label
  const pnlWeight = Math.min(1 + Math.abs(pnlPct) / 2, 3) // cap at 3x
  const lr = learningRate * pnlWeight

  const newWeights: Record<string, number> = { ...model.weights }
  for (const key of FEATURE_KEYS) {
    const grad = error * (features[key] ?? 0)
    // L2 regularization keeps weights small and generalizable
    newWeights[key] = (newWeights[key] ?? 0) - lr * grad - lr * 0.01 * (newWeights[key] ?? 0)
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
    .where(eq(mlModel.id, 1))

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

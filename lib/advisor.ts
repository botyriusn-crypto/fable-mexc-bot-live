// Super Advisor v2 — counterfactual evolution of sniper parameters.
import { db } from "./db"
import { sql } from "drizzle-orm"
import type { FeatureVector } from "./indicators"

export interface VariantParams { minConf: number; adxMin: number; needVolSurge: boolean; needTrendAlign: boolean }
export interface VariantStats { allowed: number; correct: number; sumReturn: number }
interface VariantRow { id: number; name: string; params: VariantParams; stats: VariantStats }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

// Hand-built setup score so variants have signal even before the ML matures
export function heuristicScore(f: FeatureVector, direction: string): number {
  const trendAlign = direction === "long" ? (f.crossover ?? 0) : 1 - (f.crossover ?? 0)
  const rocSign = direction === "long" ? Math.tanh((f.roc ?? 0) * 40) : Math.tanh(-(f.roc ?? 0) * 40)
  const vol = ((f.volSurge ?? 0) * 100 - 1.5) * 0.4
  const adx = ((f.adx ?? 0) - 0.25) * 2
  return sigmoid(trendAlign * 1.2 + rocSign * 0.8 + vol + adx)
}

export function variantAllowed(p: VariantParams, f: FeatureVector, direction: string, mlConf: number): boolean {
  const score = Math.max(mlConf ?? 0, heuristicScore(f, direction))
  if (score < p.minConf) return false
  if ((f.adx ?? 0) < p.adxMin) return false
  if (p.needVolSurge && (f.volSurge ?? 0) * 100 < 1.8) return false
  if (p.needTrendAlign) {
    const align = direction === "long" ? (f.crossover ?? 0) === 1 : (f.crossover ?? 0) === 0
    if (!align) return false
  }
  return true
}

export async function getVariants(): Promise<VariantRow[]> {
  const res: any = await db.execute(sql`SELECT id, name, params, stats FROM advisor_variants ORDER BY id`)
  const rows = Array.isArray(res) ? res : (res?.rows ?? [])
  return rows.map((r: any) => ({ id: r.id, name: r.name, params: r.params, stats: r.stats }))
}

// Deterministic ranking: Wilson lower confidence bound (95%).
// Ranks by PROVEN win rate, penalizing tiny samples. Fixes the old
// volume-biased formula that let loose (50% win, 165 tries) outrank
// trendRider (64% win, 25 tries).
export function scoreVariant(s: VariantStats): number {
  const n = s.allowed
  if (n <= 0) return 0
  const p = s.correct / n
  const z = 1.96
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return parseFloat(Math.max(0, center - margin).toFixed(3))
}

// Thompson sampling: exploration engine. Draws a candidate leader from
// each variant's Beta posterior. Explore with TS, rank with LCB.
export function thompsonLeader(variants: Array<{ name: string; stats: VariantStats }>): string | null {
  let best: string | null = null
  let bestDraw = -1
  for (const v of variants) {
    const draw = sampleBeta(v.stats.correct + 1, v.stats.allowed - v.stats.correct + 1)
    if (draw > bestDraw) { bestDraw = draw; best = v.name }
  }
  return best
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha)
  const y = sampleGamma(beta)
  return x / (x + y)
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number, v: number
    do {
      x = Math.random() * 2 - 1
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

// Called on every resolved shadow decision — grades all variants counterfactually
export async function recordOutcome(f: FeatureVector, direction: string, mlConf: number, correct: boolean, ret: number): Promise<void> {
  const variants = await getVariants()
  for (const v of variants) {
    if (!variantAllowed(v.params, f, direction, mlConf)) continue
    const s: VariantStats = {
      allowed: (v.stats.allowed ?? 0) + 1,
      correct: (v.stats.correct ?? 0) + (correct ? 1 : 0),
      sumReturn: (v.stats.sumReturn ?? 0) + ret,
    }
    await db.execute(sql`UPDATE advisor_variants SET stats = ${JSON.stringify(s)}::jsonb, updated_at = NOW() WHERE id = ${v.id}`)
  }
}

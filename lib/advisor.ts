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

export function scoreVariant(s: VariantStats): number {
  return ((s.correct + 1) / (s.allowed + 2)) * Math.log(1 + s.allowed)
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

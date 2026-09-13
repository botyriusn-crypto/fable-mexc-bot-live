// Super Advisor v2 — counterfactual evolution of sniper parameters.
import { db } from "./db"
import { sql } from "drizzle-orm"
import type { FeatureVector } from "./indicators"

// Sniper signal characteristics (stored in classifierDecisions.lorentzianFilters).
export interface SniperFeatures {
  signalType: "sweep" | "sigma" | null
  volSurge: number
  z: number
  fundingRate: number
}

// Variants now tune the sniper's ACTUAL rule parameters (Option A).
export interface VariantParams { minConf: number; volSurgeMult: number; sigmaExtreme: number }
export interface VariantStats { allowed: number; correct: number; sumReturn: number }
interface VariantRow { id: number; name: string; params: VariantParams; stats: VariantStats }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

// Setup-quality score in [0,1] — used by the shadow evaluator to choose between
// the ML read and the setup read (its "source" field).
//
// Two fixes here:
//
//  1. The short branch used `1 - crossover`. `crossover` is -1/0/1, so that
//     produced {0, 1, 2} — ALWAYS >= 0 — while the long branch produced
//     {-1, 0, 1}. A short therefore collected +1.2 (weighted 1.2 -> +1.44) on a
//     NEUTRAL bar and +2.4 on a bearish cross, i.e. shorts were systematically
//     scored above longs for the same signal. Negating instead of offsetting
//     gives both branches the same range.
//
//  2. volSurge arrives normalized to [-1/3, 1] — computeSnapshot does
//     clamp(vol - 1, -1, 3) / 3, so ~0.33 is a 2x surge. The old
//     `((f.volSurge ?? 0) * 100 - 1.5) * 0.4` assumed a RAW multiple and
//     produced values in [-13.8, 39.4], which saturated the sigmoid on its own
//     and collapsed the score to a near-constant, discarding every other term.
//     Rescaled to sit in the same range as the other contributions.
export function heuristicScore(f: FeatureVector, direction: string): number {
  const crossover = f.crossover ?? 0
  const trendAlign = direction === "long" ? crossover : -crossover
  const rocSign = direction === "long" ? Math.tanh((f.roc ?? 0) * 40) : Math.tanh(-(f.roc ?? 0) * 40)
  const vol = (f.volSurge ?? 0) * 1.2
  const adx = ((f.adx ?? 0) - 0.25) * 2
  return sigmoid(trendAlign * 1.2 + rocSign * 0.8 + vol + adx)
}

// Grade a variant against a sniper signal: does this param set allow the signal?
export function variantAllowed(p: VariantParams, sig: SniperFeatures, direction: string, conf: number): boolean {
  if (conf < p.minConf) return false
  if (sig.signalType === "sweep" && (sig.volSurge ?? 0) < p.volSurgeMult) return false
  if (sig.signalType === "sigma" && Math.abs(sig.z ?? 0) < p.sigmaExtreme) return false
  return true
}

export async function getVariants(): Promise<VariantRow[]> {
  const res: any = await db.execute(sql`SELECT id, name, params, stats FROM advisor_variants ORDER BY id`)
  const rows = Array.isArray(res) ? res : (res?.rows ?? [])
  return rows.map((r: any) => ({ id: r.id, name: r.name, params: r.params, stats: r.stats }))
}

// Deterministic ranking: Wilson lower confidence bound (95%).
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

// Thompson sampling: exploration engine.
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
  const denom = x + y
  // Both draws can be exactly 0 for very small integer shapes, which made this
  // return NaN. NaN always loses the `>` comparison above, so a NaN draw
  // silently removed a variant from consideration rather than flagging anything.
  // Fall back to the prior mean.
  if (!Number.isFinite(denom) || denom <= 0) return alpha / (alpha + beta)
  return x / denom
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

// Called on every resolved sniper decision — grades all variants counterfactually.
//
// The stats bump is a single atomic UPDATE (jsonb arithmetic evaluated in SQL)
// instead of read-modify-write. The old version SELECTed every variant, added
// the outcome in JS and wrote the totals back, so two concurrent graders
// (overlapping ticks, or two Fly machines) each counted the same outcome and one
// write was lost — the same stale-read pattern already fixed for the grid setup
// cooldown. We still read the row first, but only to decide whether the variant
// ALLOWS the signal; the counters themselves are incremented server-side.
export async function recordOutcome(sig: SniperFeatures, direction: string, conf: number, correct: boolean, ret: number): Promise<void> {
  const variants = await getVariants()
  for (const v of variants) {
    if (!variantAllowed(v.params, sig, direction, conf)) continue
    await db.execute(sql`
      UPDATE advisor_variants
      SET stats = jsonb_build_object(
            'allowed',   COALESCE((stats->>'allowed')::int, 0) + 1,
            'correct',   COALESCE((stats->>'correct')::int, 0) + ${correct ? 1 : 0},
            'sumReturn', COALESCE((stats->>'sumReturn')::double precision, 0) + ${ret}
          ),
          updated_at = NOW()
      WHERE id = ${v.id}
    `)
  }
}

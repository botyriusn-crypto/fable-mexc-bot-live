// AI Advisor "levers" — guardrails that bound every auto-tuned parameter so a
// single bad recommendation can never swing the bot into a catastrophic state
// (e.g. a leverage spike or a position-size blowup).

export interface FieldLimit {
  min: number
  max: number
  maxStep: number    // max absolute change per single auto-apply
  maxRelStep: number // max relative change per single auto-apply (0.5 = 50%)
}

// Hard cap on leverage. No recommendation may ever push leverage above this,
// regardless of what the model suggests. (Defensive: leverage is not yet a
// botConfig field — the grid advisor owns leverage via suggestLeverage — but
// this guards the moment it becomes tunable here.)
export const MAX_LEVERAGE = 10

// Per-field bounds, chosen from the botConfig schema defaults and the
// strategy's known-safe operating envelope. Tune these to taste.
export const FIELD_LIMITS: Record<string, FieldLimit> = {
  mlConfidenceThreshold: { min: 0.5, max: 0.95, maxStep: 0.1, maxRelStep: 0.2 },
  slAtrMult:             { min: 0.5, max: 4.0, maxStep: 0.5, maxRelStep: 0.5 },
  tpAtrMult:             { min: 1.0, max: 8.0, maxStep: 1.0, maxRelStep: 0.5 },
  emaFast:               { min: 3,   max: 50,  maxStep: 5,   maxRelStep: 0.5 },
  emaSlow:               { min: 10,  max: 200, maxStep: 20,  maxRelStep: 0.5 },
  rsiPeriod:             { min: 5,   max: 30,  maxStep: 5,   maxRelStep: 0.5 },
  momentumThreshold:     { min: 0.2, max: 1.5, maxStep: 0.3, maxRelStep: 0.5 },
  positionSizeUsdt:      { min: 5,   max: 100, maxStep: 25,  maxRelStep: 0.5 },
}

export interface RecommendationInput {
  field: string
  current: string | number | boolean
  suggested: string | number | boolean
  reason: string
  impact: string
}

export interface ClampedRecommendation extends RecommendationInput {
  clamped: number
  wasClamped: boolean
  skipped: boolean
  skipReason?: string
}

export interface ClampResult {
  applied: ClampedRecommendation[]
  skipped: ClampedRecommendation[]
}

/**
 * Clamp a list of recommendations against FIELD_LIMITS. Each numeric
 * suggestion is (1) bounded to [min, max], (2) limited to a max absolute
 * step from current, and (3) limited to a max relative step from current.
 * Non-numeric or unknown-field suggestions are returned in `skipped` with a
 * reason so the caller can log them instead of silently dropping them.
 */
export function clampRecommendations(recommendations: RecommendationInput[]): ClampResult {
  const applied: ClampedRecommendation[] = []
  const skipped: ClampedRecommendation[] = []

  for (const rec of recommendations) {
    const limit = FIELD_LIMITS[rec.field]
    const current = Number(rec.current)
    const suggested = Number(rec.suggested)

    if (!limit) {
      skipped.push({ ...rec, clamped: suggested, wasClamped: false, skipped: true, skipReason: "field not in whitelist" })
      continue
    }
    if (!Number.isFinite(current) || !Number.isFinite(suggested)) {
      skipped.push({ ...rec, clamped: suggested, wasClamped: false, skipped: true, skipReason: "non-numeric value" })
      continue
    }

    // 1. Absolute bounds
    let clamped = Math.min(limit.max, Math.max(limit.min, suggested))

    // 2. Max absolute step from current
    const step = clamped - current
    if (Math.abs(step) > limit.maxStep) {
      clamped = current + Math.sign(step) * limit.maxStep
    }

    // 3. Max relative step from current
    if (current !== 0) {
      const rel = Math.abs(clamped - current) / Math.abs(current)
      if (rel > limit.maxRelStep) {
        clamped = current + Math.sign(clamped - current) * Math.abs(current) * limit.maxRelStep
      }
    }

    // Re-apply absolute bounds after step clamps (current may sit near a bound)
    clamped = Math.min(limit.max, Math.max(limit.min, clamped))
    clamped = Math.round(clamped * 1000) / 1000

    applied.push({ ...rec, clamped, wasClamped: clamped !== suggested, skipped: false })
  }

  return { applied, skipped }
}

// AI Advisor "levers" — guardrails that bound every auto-tuned parameter so a
// single bad recommendation can never swing the bot into a catastrophic state
// (e.g. a leverage spike, a position-size blowup, or a scalper threshold so
// loose it trades every bar).

export type LeverTarget = "botConfig" | "env"

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

// ── Lever registry ───────────────────────────────────────────────────────────
//
// `target` says WHERE the value must be written for it to take effect:
//
//   "botConfig" — a real column on bot_config. applyRecommendations can write
//                 it directly, so it is auto-applicable.
//   "env"       — the value is currently read from process.env at call time
//                 (every SCALP.* threshold in lib/trend-scalper.ts, and every
//                 RISK_LIMITS value in lib/risk-manager.ts). Writing it to
//                 bot_config would be a silent no-op: the scalper never reads
//                 that table. These are therefore PROPOSE-ONLY — the advisor
//                 records them for review, and applying one requires the
//                 schema + read-path change described in the handover notes.
//
// Booleans (partialTakeEnabled, SCALP_MULTI_MARKET) are deliberately NOT in
// this registry. A language model should not be flipping whole features on and
// off; those stay human decisions. Non-numeric suggestions are reported in
// `skipped` with a reason rather than silently dropped.
export interface LeverSpec {
  limit: FieldLimit
  target: LeverTarget
  envVar?: string
}

export const LEVER_REGISTRY: Record<string, LeverSpec> = {
  // ── bot_config columns (auto-applicable) ──
  mlConfidenceThreshold: { target: "botConfig", limit: { min: 0.5,  max: 0.95, maxStep: 0.1,  maxRelStep: 0.2 } },
  mlLearningRate:        { target: "botConfig", limit: { min: 0.01, max: 0.2,  maxStep: 0.02, maxRelStep: 0.5 } },
  slAtrMult:             { target: "botConfig", limit: { min: 0.5,  max: 4.0,  maxStep: 0.5,  maxRelStep: 0.5 } },
  tpAtrMult:             { target: "botConfig", limit: { min: 1.0,  max: 8.0,  maxStep: 1.0,  maxRelStep: 0.5 } },
  trailAtrMult:          { target: "botConfig", limit: { min: 0.5,  max: 3.0,  maxStep: 0.3,  maxRelStep: 0.4 } },
  momentumThreshold:     { target: "botConfig", limit: { min: 0.2,  max: 1.5,  maxStep: 0.3,  maxRelStep: 0.5 } },
  emaFast:               { target: "botConfig", limit: { min: 3,    max: 50,   maxStep: 5,    maxRelStep: 0.5 } },
  emaSlow:               { target: "botConfig", limit: { min: 10,   max: 200,  maxStep: 20,   maxRelStep: 0.5 } },
  rsiPeriod:             { target: "botConfig", limit: { min: 5,    max: 30,   maxStep: 5,    maxRelStep: 0.5 } },
  positionSizeUsdt:      { target: "botConfig", limit: { min: 5,    max: 100,  maxStep: 25,   maxRelStep: 0.5 } },
  partialAtrMult:        { target: "botConfig", limit: { min: 0.5,  max: 3.0,  maxStep: 0.5,  maxRelStep: 0.5 } },
  partialFraction:       { target: "botConfig", limit: { min: 0.25, max: 0.75, maxStep: 0.1,  maxRelStep: 0.4 } },

  // ── SCALP_* runtime thresholds (PROPOSE-ONLY until they move to the DB) ──
  // Bounds are deliberately tighter than the schema-style ranges: these are
  // entry gates on a live strategy, so a large single step is far more
  // dangerous than a large step on a stop multiple.
  adxMin:            { target: "env", envVar: "SCALP_ADX_MIN",            limit: { min: 10,     max: 35,   maxStep: 4,     maxRelStep: 0.3 } },
  adxMax:            { target: "env", envVar: "SCALP_ADX_MAX",            limit: { min: 30,     max: 70,   maxStep: 6,     maxRelStep: 0.3 } },
  atrPctMin:         { target: "env", envVar: "SCALP_ATRPCT_MIN",         limit: { min: 0.0005, max: 0.01, maxStep: 0.001, maxRelStep: 0.5 } },
  atrPctMax:         { target: "env", envVar: "SCALP_ATRPCT_MAX",         limit: { min: 0.03,   max: 0.20, maxStep: 0.02,  maxRelStep: 0.5 } },
  pullbackLookback:  { target: "env", envVar: "SCALP_PULLBACK_LOOKBACK",  limit: { min: 3,      max: 12,   maxStep: 2,     maxRelStep: 0.5 } },
  scoreThreshold:    { target: "env", envVar: "SCALP_SCORE_THRESHOLD",    limit: { min: 0.35,   max: 0.80, maxStep: 0.05,  maxRelStep: 0.15 } },
  riskPct:           { target: "env", envVar: "SCALP_RISK_PCT",           limit: { min: 0.002,  max: 0.02, maxStep: 0.002, maxRelStep: 0.25 } },
  rMultiple:         { target: "env", envVar: "SCALP_R_MULTIPLE",         limit: { min: 1.0,    max: 4.0,  maxStep: 0.25,  maxRelStep: 0.3 } },
  flowWeight:        { target: "env", envVar: "SCALP_FLOW_WEIGHT",        limit: { min: 0,      max: 1,    maxStep: 0.2,   maxRelStep: 0.5 } },
  maxOpen:           { target: "env", envVar: "SCALP_MAX_OPEN",           limit: { min: 1,      max: 6,    maxStep: 1,     maxRelStep: 0.5 } },

  // ── Risk limits (PROPOSE-ONLY for the same reason) ──
  maxDailyLossPct:   { target: "env", envVar: "MAX_DAILY_LOSS_PCT",       limit: { min: 0.03,   max: 0.15, maxStep: 0.01,  maxRelStep: 0.25 } },
  maxDrawdownPct:    { target: "env", envVar: "MAX_DRAWDOWN_PCT",         limit: { min: 0.10,   max: 0.35, maxStep: 0.03,  maxRelStep: 0.25 } },
  maxTotalMarginPct: { target: "env", envVar: "MAX_TOTAL_MARGIN_PCT",     limit: { min: 0.30,   max: 0.80, maxStep: 0.05,  maxRelStep: 0.25 } },
  maxOpenPositions:  { target: "env", envVar: "MAX_OPEN_POSITIONS",       limit: { min: 1,      max: 8,    maxStep: 1,     maxRelStep: 0.5 } },
}

// Backwards-compatible view of the registry: field -> bounds. Kept exported
// because it is the public shape callers already know.
export const FIELD_LIMITS: Record<string, FieldLimit> = Object.fromEntries(
  Object.entries(LEVER_REGISTRY).map(([field, spec]) => [field, spec.limit]),
)

// ── Coherence rules ──────────────────────────────────────────────────────────
// Independent per-field clamping is not enough: two individually-legal
// suggestions can combine into an incoherent config. A scalper whose ADX floor
// exceeds its ADX ceiling rejects every bar; an ATR band whose floor exceeds
// its ceiling does the same. Each rule reads the EFFECTIVE value of both sides
// (the clamped suggestion where present, otherwise the current value).
export interface CoherenceRule {
  fields: [string, string]
  describe: string
  ok: (a: number, b: number) => boolean
}

export const COHERENCE_RULES: CoherenceRule[] = [
  { fields: ["adxMin", "adxMax"],        describe: "adxMin must be < adxMax",               ok: (a, b) => a < b },
  { fields: ["atrPctMin", "atrPctMax"],  describe: "atrPctMin must be < atrPctMax",         ok: (a, b) => a < b },
  { fields: ["emaFast", "emaSlow"],      describe: "emaFast must be < emaSlow",             ok: (a, b) => a < b },
  { fields: ["partialFraction", "partialAtrMult"], describe: "both must be > 0",              ok: (a, b) => a > 0 && b > 0 },
  { fields: ["slAtrMult", "tpAtrMult"],  describe: "tpAtrMult should be >= slAtrMult",      ok: (a, b) => b >= a },
]

/**
 * Check a set of proposed values against every coherence rule. `current` is
 * consulted for any field the proposal does not mention, so a proposal that
 * changes only one side of a pair is still validated against the other side as
 * it stands today. Returns the first violated rule, or { ok: true }.
 */
export function validateCoherence(
  proposed: Record<string, number>,
  current: Record<string, number>,
): { ok: true } | { ok: false; reason: string } {
  const effective = (field: string): number | null => {
    const v = proposed[field] ?? current[field]
    return Number.isFinite(v) ? Number(v) : null
  }

  for (const rule of COHERENCE_RULES) {
    const [fa, fb] = rule.fields
    // Only enforce a rule when the proposal touches at least one of its fields
    // AND we actually know both sides — an absent current value must not
    // manufacture a failure.
    if (!(fa in proposed) && !(fb in proposed)) continue
    const a = effective(fa)
    const b = effective(fb)
    if (a == null || b == null) continue
    if (!rule.ok(a, b)) {
      return { ok: false, reason: `${rule.describe} (would be ${a} / ${b})` }
    }
  }
  return { ok: true }
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
  target: LeverTarget
}

export interface ClampResult {
  applied: ClampedRecommendation[]
  skipped: ClampedRecommendation[]
}

/**
 * Clamp a list of recommendations against LEVER_REGISTRY. Each numeric
 * suggestion is (1) bounded to [min, max], (2) limited to a max absolute step
 * from current, and (3) limited to a max relative step from current.
 * Non-numeric or unknown-field suggestions are returned in `skipped` with a
 * reason so the caller can log them instead of silently dropping them.
 *
 * Note this does NOT enforce coherence between fields — call validateCoherence
 * on the resulting values (see applyRecommendations) so a pair of individually
 * legal suggestions cannot combine into a config that rejects every bar.
 */
export function clampRecommendations(recommendations: RecommendationInput[]): ClampResult {
  const applied: ClampedRecommendation[] = []
  const skipped: ClampedRecommendation[] = []

  for (const rec of recommendations) {
    const spec = LEVER_REGISTRY[rec.field]
    const target: LeverTarget = spec?.target ?? "botConfig"
    const current = Number(rec.current)
    const suggested = Number(rec.suggested)

    if (!spec) {
      skipped.push({ ...rec, clamped: suggested, wasClamped: false, skipped: true, skipReason: "field not in whitelist", target })
      continue
    }
    if (!Number.isFinite(current) || !Number.isFinite(suggested)) {
      skipped.push({ ...rec, clamped: suggested, wasClamped: false, skipped: true, skipReason: "non-numeric value (boolean/feature levers stay human-controlled)", target })
      continue
    }

    const limit = spec.limit

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

    if (clamped === current) {
      skipped.push({ ...rec, clamped, wasClamped: false, skipped: true, skipReason: "already at this value after clamping", target })
      continue
    }

    applied.push({ ...rec, clamped, wasClamped: clamped !== suggested, skipped: false, target })
  }

  return { applied, skipped }
}

/** The canonical field names the model is allowed to propose. Built from the
 *  registry so the prompt can never drift out of sync with the guardrails. */
export function allowedFields(): string[] {
  return Object.keys(LEVER_REGISTRY)
}

/** Current-value lookup used to seed the prompt. */
export function leverDefault(field: string, fallback: number): number {
  const spec = LEVER_REGISTRY[field]
  if (!spec) return fallback
  const mid = (spec.limit.min + spec.limit.max) / 2
  return Number.isFinite(mid) ? Math.round(mid * 1000) / 1000 : fallback
}

// Map human-readable display names (what DeepSeek sometimes emits) to the
// canonical camelCase keys used by LEVER_REGISTRY. Safety net: the prompt asks
// for canonical names, but if the model echoes a display name like
// "ML Confidence Threshold", we still resolve it correctly.
export function normalizeField(field: string): string {
  if (LEVER_REGISTRY[field]) return field
  const norm = field.toLowerCase().replace(/[^a-z0-9]/g, "")
  const aliases: Record<string, string> = {
    mlconfidencethreshold: "mlConfidenceThreshold",
    mltrainingrate: "mlLearningRate",
    mllearningrate: "mlLearningRate",
    stoplossatrmultiplier: "slAtrMult",
    slatrmultiplier: "slAtrMult",
    takeprofitatrmultiplier: "tpAtrMult",
    tpatrmultiplier: "tpAtrMult",
    trailingatrmultiplier: "trailAtrMult",
    trailatrmultiplier: "trailAtrMult",
    emafast: "emaFast",
    emaslow: "emaSlow",
    rsiperiod: "rsiPeriod",
    momentumthreshold: "momentumThreshold",
    positionsize: "positionSizeUsdt",
    positionsizeusdt: "positionSizeUsdt",
    partialatrmult: "partialAtrMult",
    partialatrmultiplier: "partialAtrMult",
    partialfraction: "partialFraction",
    // scalper thresholds
    scalpadxmin: "adxMin",
    adxmin: "adxMin",
    scalpadxmax: "adxMax",
    adxmax: "adxMax",
    scalpatrpctmin: "atrPctMin",
    atrpctmin: "atrPctMin",
    scalpatrpctmax: "atrPctMax",
    atrpctmax: "atrPctMax",
    scalppullbacklookback: "pullbackLookback",
    pullbacklookback: "pullbackLookback",
    scalpscorethreshold: "scoreThreshold",
    scorethreshold: "scoreThreshold",
    scalpriskpct: "riskPct",
    riskpct: "riskPct",
    scalprmultiple: "rMultiple",
    rmultiple: "rMultiple",
    scalpflowweight: "flowWeight",
    flowweight: "flowWeight",
    scalpmaxopen: "maxOpen",
    maxopen: "maxOpen",
    // risk limits
    maxdailylosspct: "maxDailyLossPct",
    maxdrawdownpct: "maxDrawdownPct",
    maxtotalmarginpct: "maxTotalMarginPct",
    maxopenpositions: "maxOpenPositions",
    // legacy sniper aliases kept so older stored recommendations still resolve
    snipersigmaextreme: "sniperSigmaExtreme",
    snipersigma: "sniperSigmaExtreme",
    snipervolumesurge: "sniperVolumeSurgeMult",
    snipervolumesurgemult: "sniperVolumeSurgeMult",
    sniperminvolume: "sniperMinVolumeUsdt",
    sniperminvolumeusdt: "sniperMinVolumeUsdt",
    snipermaxentries: "sniperMaxEntries",
    sniperpositionsize: "sniperPositionSizeUsdt",
    sniperpositionsizeusdt: "sniperPositionSizeUsdt",
    sniperleverage: "sniperLeverage",
    sniperconfidencefloor: "sniperConfidenceFloor",
    snipercorrthreshold: "sniperCorrThreshold",
    snipercorrelationthreshold: "sniperCorrThreshold",
    snipermomentumthreshold: "sniperMomentumThreshold",
    snipermomentum: "sniperMomentumThreshold",
    snipertrailatrmult: "sniperTrailAtrMult",
    snipertrail: "sniperTrailAtrMult",
  }
  if (aliases[norm]) return aliases[norm]
  for (const canonical of Object.keys(LEVER_REGISTRY)) {
    if (canonical.toLowerCase().replace(/[^a-z0-9]/g, "") === norm) return canonical
  }
  return field
}

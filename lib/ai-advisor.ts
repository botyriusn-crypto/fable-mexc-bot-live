import { db } from "./db"
import { trades, botConfig, aiRecommendations } from "./db/schema"
import { eq, desc, and } from "drizzle-orm"
import {
  clampRecommendations,
  normalizeField,
  validateCoherence,
  allowedFields,
  LEVER_REGISTRY,
  type RecommendationInput,
  type ClampedRecommendation,
} from "./ai-levers"

export interface TradeAnalysis {
  tradeCount: number
  avgReturn: number
  winRate: number
  recentTrades: Array<{ side: string; pnl: number; fees: number; exitReason: string }>
}

export interface Recommendation {
  field: string
  current: string | number | boolean
  suggested: string | number | boolean
  reason: string
  impact: string
}

// ── Grouped statistics ───────────────────────────────────────────────────────
// A flat "avg return / win rate" over 50 mixed trades hides the structure that
// actually explains performance: which STRATEGY lost, in which REGIME, on which
// SIDE, and at which EXIT. The prompt now carries those breakdowns, so the
// model recommends against a cause rather than against an average.

interface GroupStat {
  key: string
  n: number
  netPnl: number
  netFees: number
  wins: number
  avgPnl: number
  winRate: number
}

type TradeRow = typeof trades.$inferSelect

function summarizeGroups(rows: TradeRow[], keyFn: (r: TradeRow) => string): GroupStat[] {
  const buckets = new Map<string, TradeRow[]>()
  for (const r of rows) {
    const k = keyFn(r) || "(none)"
    const arr = buckets.get(k)
    if (arr) arr.push(r)
    else buckets.set(k, [r])
  }
  const out: GroupStat[] = []
  for (const [key, group] of buckets) {
    const netPnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const netFees = group.reduce((s, t) => s + (t.fees ?? 0), 0)
    const wins = group.filter((t) => (t.pnl ?? 0) > 0).length
    out.push({
      key,
      n: group.length,
      netPnl,
      netFees,
      wins,
      avgPnl: netPnl / group.length,
      winRate: group.length > 0 ? wins / group.length : 0,
    })
  }
  // Worst net PnL first — the groups most worth acting on.
  return out.sort((a, b) => a.netPnl - b.netPnl)
}

function formatGroups(label: string, stats: GroupStat[]): string {
  if (stats.length === 0) return `${label}: (no trades)`
  const lines = stats.map(
    (s) =>
      `  ${s.key}: n=${s.n}, net=$${s.netPnl.toFixed(2)}, fees=$${s.netFees.toFixed(2)}, ` +
      `avg=$${s.avgPnl.toFixed(2)}, win=${(s.winRate * 100).toFixed(0)}%`,
  )
  return `${label}:\n${lines.join("\n")}`
}

// ── Current lever values (what the prompt reports, and what clamping anchors to) ──

async function currentLeverValues(): Promise<{ values: Record<string, number>; missing: string[] }> {
  const values: Record<string, number> = {}
  const missing: string[] = []

  // bot_config columns
  const cfgRows = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
  const cfg = cfgRows[0]
  if (!cfg) return { values, missing: allowedFields() }

  const fromCfg: Record<string, unknown> = {
    mlConfidenceThreshold: cfg.mlConfidenceThreshold,
    mlLearningRate: cfg.mlLearningRate,
    slAtrMult: cfg.slAtrMult,
    tpAtrMult: cfg.tpAtrMult,
    trailAtrMult: cfg.trailAtrMult,
    momentumThreshold: cfg.momentumThreshold,
    emaFast: cfg.emaFast,
    emaSlow: cfg.emaSlow,
    rsiPeriod: cfg.rsiPeriod,
    positionSizeUsdt: cfg.positionSizeUsdt,
    partialAtrMult: cfg.partialAtrMult,
    partialFraction: cfg.partialFraction,
    // Scalper levers are now real columns (migration 0011). Read them straight
    // from the row: going through SCALP.* would report a stale module snapshot
    // when the advisor runs before the first tick, and the clamp anchors to
    // whatever this reports.
    scalpAdxMin: cfg.scalpAdxMin,
    scalpAdxMax: cfg.scalpAdxMax,
    scalpAtrPctMin: cfg.scalpAtrPctMin,
    scalpAtrPctMax: cfg.scalpAtrPctMax,
    scalpPullbackLookback: cfg.scalpPullbackLookback,
    scalpScoreThreshold: cfg.scalpScoreThreshold,
    scalpRiskPct: cfg.scalpRiskPct,
    scalpRMultiple: cfg.scalpRMultiple,
    scalpFlowWeight: cfg.scalpFlowWeight,
    scalpMaxOpen: cfg.scalpMaxOpen,
  }
  for (const [k, v] of Object.entries(fromCfg)) {
    const n = Number(v)
    if (Number.isFinite(n)) values[k] = n
  }

  // Risk limits are still env-backed (lib/risk-manager.ts reads process.env at
  // call time), so they remain PROPOSE-ONLY: lib/ai-levers.ts targets them at
  // "env" and applyRecommendations records, never writes, them.
  try {
    const { RISK_LIMITS } = await import("./risk-manager")
    values.maxDailyLossPct = RISK_LIMITS.maxDailyLossPct()
    values.maxDrawdownPct = RISK_LIMITS.maxDrawdownPct()
    values.maxTotalMarginPct = RISK_LIMITS.maxTotalMarginPct()
    values.maxOpenPositions = RISK_LIMITS.maxOpenPositions()
  } catch (err) {
    console.warn("[AI Advisor] could not read risk limits:", err instanceof Error ? err.message : String(err))
  }

  for (const field of allowedFields()) {
    if (!(field in values)) missing.push(field)
  }
  return { values, missing }
}

// ── LLM call ─────────────────────────────────────────────────────────────────

const LLM_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 30_000)
const LLM_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS ?? 1600)

async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY
  const model = process.env.AI_MODEL || "deepseek-chat"

  if (!apiKey) throw new Error("DEEPSEEK_API_KEY or ANTHROPIC_API_KEY not set")

  // DeepSeek uses an OpenAI-compatible API
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"

  // Bounded: an unresponsive model must never stall the tick that called this.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: LLM_MAX_TOKENS,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`DeepSeek API error: ${response.status} ${body.slice(0, 200)}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content || ""
  } finally {
    clearTimeout(timer)
  }
}

interface ParsedRecommendation extends RecommendationInput {
  /** Set when the model omitted or mis-typed a field; moved to `skipped`. */
  parseNote?: string
}

function parseRecommendationPayload(text: string): { items: ParsedRecommendation[]; note: string } {
  // Accept either a bare array or an object wrapping one ("recommendations": [...]).
  let parsed: unknown = null
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try { parsed = JSON.parse(arrayMatch[0]) } catch { /* fall through */ }
  }
  if (parsed == null) {
    const objectMatch = text.match(/\{[\s\S]*\}/)
    if (objectMatch) {
      try {
        const obj = JSON.parse(objectMatch[0]) as Record<string, unknown>
        if (Array.isArray(obj.recommendations)) parsed = obj.recommendations
      } catch { /* fall through */ }
    }
  }
  if (!Array.isArray(parsed)) {
    return { items: [], note: "model returned no parseable JSON array" }
  }

  const items: ParsedRecommendation[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const fieldRaw = typeof r.field === "string" ? r.field : ""
    if (!fieldRaw) continue
    const field = normalizeField(fieldRaw)
    // Current value the model reported is advisory only; the registry's live
    // read overrides it below, so a hallucinated "current" can't anchor the clamp.
    items.push({
      field,
      current: (r.current ?? 0) as string | number | boolean,
      suggested: (r.suggested ?? r.value ?? 0) as string | number | boolean,
      reason: typeof r.reason === "string" ? r.reason : "",
      impact: typeof r.impact === "string" ? r.impact : "",
    })
  }
  return { items, note: "" }
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(args: {
  symbol: string
  timeframe: string
  rows: TradeRow[]
  current: Record<string, number>
  missing: string[]
  marketContext: string
  minTrades: number
}): string {
  const { symbol, timeframe, rows, current, marketContext } = args

  const totalReturn = rows.reduce((s, t) => s + ((t.pnl ?? 0) - (t.fees ?? 0)), 0)
  const avgReturn = rows.length > 0 ? totalReturn / rows.length : 0
  const wins = rows.filter((t) => (t.pnl ?? 0) - (t.fees ?? 0) > 0).length
  const winRate = rows.length > 0 ? wins / rows.length : 0
  const grossWins = rows.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLosses = Math.abs(rows.filter((t) => (t.pnl ?? 0) < 0).reduce((s, t) => s + t.pnl, 0))

  const byStrategy = summarizeGroups(rows, (t) => t.strategy ?? "unknown")
  const byRegime = summarizeGroups(rows, (t) => t.entryRegime ?? "unknown")
  const bySide = summarizeGroups(rows, (t) => t.side ?? "unknown")
  const byExit = summarizeGroups(rows, (t) => t.exitReason ?? "unknown")

  const focus = rows.filter(
    (t) => t.strategy === "scalp" || t.strategy === "trend" || t.strategy === "range",
  )
  const focusLine = focus.length > 0
    ? `Primary-strategy subset used for the breakdowns below: ${focus.length} trade(s).`
    : "No trend/scalp/range trades in the window; breakdowns cover everything."

  const leverLines = Object.keys(LEVER_REGISTRY)
    .filter((f) => f in current)
    .map((f) => {
      const spec = LEVER_REGISTRY[f]
      const scope = spec.target === "botConfig" ? "auto-applied" : "proposal-only (needs manual apply)"
      return `- ${f} = ${current[f]}  [allowed ${spec.limit.min}..${spec.limit.max}, max step ±${spec.limit.maxStep} per apply, ${scope}]`
    })
    .join("\n")

  const fieldsCsv = allowedFields().join(", ")

  return `You are a quantitative trading advisor for an automated crypto-futures bot. Your job is to find the CAUSE of underperformance in the breakdowns and propose bounded parameter changes against it.

${marketContext}MARKET: ${symbol} / ${timeframe}
Trades in window: ${rows.length}
Net (after fees): $${totalReturn.toFixed(2)}
Average per trade: $${avgReturn.toFixed(2)}
Win rate: ${(winRate * 100).toFixed(1)}% (${wins}W / ${rows.length - wins}L)
Gross wins: $${grossWins.toFixed(2)} | Gross losses: $${grossLosses.toFixed(2)} | Profit factor: ${grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : "n/a"}
${focusLine}

${formatGroups("BY STRATEGY (worst net first)", byStrategy)}

${formatGroups("BY ENTRY REGIME (worst net first)", byRegime)}

${formatGroups("BY SIDE (worst net first)", bySide)}

${formatGroups("BY EXIT REASON (worst net first)", byExit)}

LAST 10 TRADES:
${rows.slice(0, 10).map((t, i) =>
  `  ${i + 1}. ${(t.side ?? "").toUpperCase()} ${t.strategy ?? "?"} regime=${t.entryRegime ?? "?"} ` +
  `entry=${t.entryPrice} exit=${t.exitPrice} pnl=$${(t.pnl ?? 0).toFixed(2)} fees=$${(t.fees ?? 0).toFixed(2)} exit=${t.exitReason}`,
).join("\n")}

CURRENT PARAMETERS (with the range you may propose within):
${leverLines}

CURRENT PARAMETERS (with the range you may propose within):
${leverLines}

RULES:
1. Propose 2-4 changes. Each must name a cause visible in the breakdowns above.
2. Use ONLY these field names, exactly as written: ${fieldsCsv}
3. Never propose a change larger than the stated max step. Bounds are enforced, but a proposal outside them is wasted.
4. Reference the current value in "current" and the target in "suggested".
5. Prefer a small, testable change over a large one. If the data is too thin to justify a change, return an empty array.
6. Do not propose anything for a field whose value is already at the edge of its range in the direction you want to move it.

Return ONLY a JSON array, no prose:
[{"field":"scalpScoreThreshold","current":0.5,"suggested":0.55,"reason":"scalp win rate 31% at n=42; raising the confluence floor removes the weakest setups","impact":"fewer entries, expected win-rate lift to ~40%"}]`
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Minimum closed trades required before the advisor will speak. */
  minTrades?: number
  /** Trades to pull into the analysis window. */
  window?: number
}

export async function analyzeTradesForMarket(
  symbol: string,
  timeframe: string,
  opts: AnalyzeOptions = {},
): Promise<{ analysis: TradeAnalysis; recommendations: Recommendation[]; clamped: ClampedRecommendation[]; skipped: ClampedRecommendation[]; current: Record<string, number> } | null> {
  const minTrades = Math.max(1, opts.minTrades ?? Number(process.env.AI_MIN_TRADES ?? 20))
  const window = Math.max(10, opts.window ?? Number(process.env.AI_TRADE_WINDOW ?? 100))

  const recentTrades = await db
    .select()
    .from(trades)
    .where(and(eq(trades.symbol, symbol)))
    .orderBy(desc(trades.closedAt))
    .limit(window)

  if (recentTrades.length < minTrades) {
    throw new Error(`Need at least ${minTrades} closed trades for ${symbol} (found ${recentTrades.length})`)
  }

  const cfgRows = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
  if (!cfgRows.length) return null

  const totalReturn = recentTrades.reduce((s, t) => s + ((t.pnl ?? 0) - (t.fees ?? 0)), 0)
  const avgReturn = totalReturn / recentTrades.length
  const winCount = recentTrades.filter((t) => (t.pnl ?? 0) - (t.fees ?? 0) > 0).length
  const winRate = winCount / recentTrades.length

  const analysis: TradeAnalysis = {
    tradeCount: recentTrades.length,
    avgReturn,
    winRate,
    recentTrades: recentTrades.map((t) => ({
      side: t.side, pnl: t.pnl, fees: t.fees, exitReason: t.exitReason,
    })),
  }

  // Optional market context (best-effort)
  let marketContext = ""
  try {
    const apiKey = process.env.CRYPTODATA_API_KEY
    if (apiKey) {
      const res = await fetch("https://cryptodataapi.com/api/v1/backtesting/daily-snapshots?limit=1", {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = await res.json()
        marketContext = data?.length
          ? `\nMARKET CONTEXT (latest snapshot): ${JSON.stringify(data[0]).slice(0, 200)}\n`
          : ""
      }
    }
  } catch (err) { /* best-effort */ }

  const { values: current, missing } = await currentLeverValues()

  const prompt = buildPrompt({ symbol, timeframe, rows: recentTrades, current, missing, marketContext, minTrades })
  const text = await callLLM(prompt)
  const { items, note } = parseRecommendationPayload(text)

  // Anchor each proposal to the LIVE current value, not the model's claim —
  // a hallucinated "current" must not widen the clamp window.
  for (const it of items) {
    const live = current[it.field]
    if (Number.isFinite(live)) it.current = live
  }

  const { applied, skipped } = clampRecommendations(items)

  const recommendations: Recommendation[] = applied.map((r) => ({
    field: r.field,
    current: r.current,
    suggested: r.clamped,
    reason: r.reason,
    impact: r.impact,
  }))

  // Persist the proposal set for review. `status` stays "pending" here even
  // when the caller will auto-apply, so a proposal is never lost.
  await db.insert(aiRecommendations).values({
    symbol,
    timeframe,
    tradeCount: analysis.tradeCount,
    avgReturn: analysis.avgReturn,
    winRate: analysis.winRate,
    currentSettings: current,
    recommendations: {
      proposed: recommendations,
      clamped: applied,
      skipped,
      parseNote: note,
      minTrades,
      window,
    },
    status: "pending",
  })

  if (note) console.warn(`[AI Advisor] ${note}`)
  if (skipped.length > 0) {
    console.warn(`[AI Advisor] ${skipped.length} suggestion(s) rejected: ${skipped.map((s) => `${s.field} (${s.skipReason})`).join(", ")}`)
  }

  return { analysis, recommendations, clamped: applied, skipped, current }
}

export interface ApplyOptions {
  /** When false (default), proposals are recorded but nothing is written. */
  autoApply?: boolean
}

/**
 * Apply a recommendation set.
 *
 * Guards, in order:
 *   1. Re-clamp against the registry using the LIVE current values, so a stored
 *      proposal can never be applied with stale or model-supplied anchors.
 *   2. Coherence — reject a set whose fields combine into an incoherent config
 *      (e.g. scalpAdxMin >= scalpAdxMax), after per-field clamping.
 *   3. Target split — only "botConfig" levers are written. "env" levers (the
 *      RISK_LIMITS) are recorded for manual apply, because writing them to
 *      bot_config would be a silent no-op.
 */
export async function applyRecommendations(
  recommendationId: number,
  recommendations: Array<{ field: string; current: unknown; suggested: unknown; reason: string; impact: string }>,
  opts: ApplyOptions = {},
): Promise<{ ok: boolean; appliedFields: string[]; proposeOnlyFields: string[]; skipped: string[]; reason?: string }> {
  const autoApply = opts.autoApply ?? false
  const empty = { ok: false, appliedFields: [] as string[], proposeOnlyFields: [] as string[], skipped: [] as string[] }

  try {
    const { values: current } = await currentLeverValues()

    const normalized: RecommendationInput[] = recommendations.map((rec) => {
      const field = normalizeField(rec.field)
      const live = current[field]
      return {
        field,
        current: Number.isFinite(live) ? live : (rec.current as string | number | boolean),
        suggested: rec.suggested as string | number | boolean,
        reason: rec.reason,
        impact: rec.impact,
      }
    })

    const { applied, skipped } = clampRecommendations(normalized)

    if (applied.length === 0) {
      return { ...empty, skipped: skipped.map((s) => `${s.field}: ${s.skipReason}`) }
    }

    // Coherence on the post-clamp values.
    const proposed: Record<string, number> = {}
    for (const rec of applied) proposed[rec.field] = rec.clamped
    const coherence = validateCoherence(proposed, current)
    if (!coherence.ok) {
      return { ...empty, reason: `incoherent parameter set: ${coherence.reason}`, skipped: skipped.map((s) => `${s.field}: ${s.skipReason}`) }
    }

    // Registry keys for "botConfig" levers are the drizzle column property
    // names verbatim (scalpAdxMin -> scalp_adx_min), so the key IS the write
    // target — no separate mapping table to drift out of sync.
    const botConfigUpdates: Record<string, number> = {}
    const proposeOnlyFields: string[] = []
    for (const rec of applied) {
      if (rec.target === "botConfig") botConfigUpdates[rec.field] = rec.clamped
      else proposeOnlyFields.push(rec.field)
      if (rec.wasClamped) {
        console.warn(`[AI Advisor] Clamped ${rec.field}: ${rec.current} -> ${rec.suggested} -> ${rec.clamped}`)
      }
    }

    for (const rec of skipped) {
      console.warn(`[AI Advisor] Skipped ${rec.field}: ${rec.skipReason}`)
    }

    if (!autoApply) {
      return {
        ok: false,
        appliedFields: [],
        proposeOnlyFields: Object.keys(botConfigUpdates).concat(proposeOnlyFields),
        skipped: skipped.map((s) => `${s.field}: ${s.skipReason}`),
        reason: "autoApply disabled — proposals recorded, nothing written",
      }
    }

    if (Object.keys(botConfigUpdates).length > 0) {
      await db.update(botConfig)
        .set({ ...botConfigUpdates, updatedAt: new Date() })
        .where(eq(botConfig.id, 1))
    }

    // Mark the audit row applied only when we were handed a real id. The engine
    // currently passes 0, which matches no row — updating it is a silent no-op,
    // so skip the query rather than pretend.
    if (recommendationId > 0) {
      await db.update(aiRecommendations)
        .set({ status: "applied", appliedAt: new Date() })
        .where(eq(aiRecommendations.id, recommendationId))
    }

    return {
      ok: Object.keys(botConfigUpdates).length > 0,
      appliedFields: Object.keys(botConfigUpdates),
      proposeOnlyFields,
      skipped: skipped.map((s) => `${s.field}: ${s.skipReason}`),
    }
  } catch (error) {
    console.error("[Apply recommendations] error:", error)
    return { ...empty, reason: error instanceof Error ? error.message : "unknown error" }
  }
}

/**
 * Dry run: clamp a stored proposal set and report exactly what would change,
 * without writing anything. For the UI's preview.
 */
export async function previewRecommendations(
  recommendations: Array<{ field: string; current: unknown; suggested: unknown; reason: string; impact: string }>,
): Promise<{ applied: ClampedRecommendation[]; skipped: ClampedRecommendation[]; coherence: { ok: boolean; reason?: string } }> {
  const { values: current } = await currentLeverValues()
  const normalized: RecommendationInput[] = recommendations.map((rec) => {
    const field = normalizeField(rec.field)
    const live = current[field]
    return {
      field,
      current: Number.isFinite(live) ? live : (rec.current as string | number | boolean),
      suggested: rec.suggested as string | number | boolean,
      reason: rec.reason,
      impact: rec.impact,
    }
  })
  const { applied, skipped } = clampRecommendations(normalized)
  const proposed: Record<string, number> = {}
  for (const rec of applied) proposed[rec.field] = rec.clamped
  const check = validateCoherence(proposed, current)
  return { applied, skipped, coherence: check.ok ? { ok: true } : { ok: false, reason: check.reason } }
}

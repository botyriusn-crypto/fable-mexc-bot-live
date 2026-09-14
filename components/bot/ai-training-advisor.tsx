"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectItem } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// ── Wire types (mirror lib/ai-levers + lib/ai-advisor) ──────────────────────

type LeverTarget = "botConfig" | "env"

interface ClampedRecommendation {
  field: string
  current: string | number | boolean
  suggested: string | number | boolean
  reason: string
  impact: string
  clamped: number
  wasClamped: boolean
  skipped: boolean
  skipReason?: string
  target: LeverTarget
}

interface RawRecommendation {
  field: string
  current: unknown
  suggested: unknown
  reason: string
  impact: string
}

interface AnalyzeResponse {
  success: boolean
  error?: string
  analysis?: { tradeCount: number; avgReturn: number; winRate: number }
  recommendations?: RawRecommendation[]
  clamped?: ClampedRecommendation[]
  skipped?: ClampedRecommendation[]
  current?: Record<string, number>
}

interface PreviewResponse {
  success: boolean
  error?: string
  applied?: ClampedRecommendation[]
  skipped?: ClampedRecommendation[]
  coherence?: { ok: boolean; reason?: string }
}

interface ApplyResponse {
  success: boolean
  error?: string
  reason?: string
  ok?: boolean
  appliedFields?: string[]
  proposeOnlyFields?: string[]
  skipped?: string[]
}

interface StoredProposal {
  id: number
  symbol: string
  timeframe: string
  analysisAt: string
  tradeCount: number
  avgReturn: number
  winRate: number
  status: string
  appliedAt: string | null
}

// ── Small helpers ───────────────────────────────────────────────────────────

function num(v: unknown, digits = 4): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v ?? "—")
  return String(Number(n.toFixed(digits)))
}

function pct(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}

function money(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return "—"
  return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

// A field the guardrails would actually write to bot_config, as opposed to one
// recorded for manual apply (RISK_LIMITS are still env-backed). The distinction
// is what tells the user whether pressing Apply does anything for that row.
function isAutoApplicable(rec: ClampedRecommendation): boolean {
  return rec.target === "botConfig"
}

export function AiTrainingAdvisor() {
  const [symbol, setSymbol] = React.useState("BTC_USDT")
  const [timeframe, setTimeframe] = React.useState("Min15")
  const [autoApply, setAutoApply] = React.useState(false)

  const [analyzing, setAnalyzing] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [analysis, setAnalysis] = React.useState<AnalyzeResponse | null>(null)
  const [raw, setRaw] = React.useState<RawRecommendation[]>([])
  const [preview, setPreview] = React.useState<PreviewResponse | null>(null)
  const [applyResult, setApplyResult] = React.useState<ApplyResponse | null>(null)
  const [proposals, setProposals] = React.useState<StoredProposal[]>([])

  const loadProposals = React.useCallback(async () => {
    try {
      const res = await fetch("/api/bot/ai-training", { cache: "no-store" })
      const json = await res.json()
      if (json?.success) setProposals(json.proposals ?? [])
    } catch {
      /* history is best-effort; the panel still works without it */
    }
  }, [])

  React.useEffect(() => {
    loadProposals()
  }, [loadProposals])

  const analyze = async () => {
    setAnalyzing(true)
    setError(null)
    setApplyResult(null)
    try {
      const res = await fetch("/api/bot/ai-training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze", symbol, timeframe }),
      })
      const json: AnalyzeResponse = await res.json()
      if (!json.success) {
        setError(json.error ?? "analysis failed")
        setAnalysis(null)
        setRaw([])
        setPreview(null)
        return
      }
      setAnalysis(json)
      setRaw(json.recommendations ?? [])
      // analyze() already ran the clamp, so the review renders from its output;
      // the Preview button re-runs it against the LIVE bounds.
      setPreview({
        success: true,
        applied: json.clamped ?? [],
        skipped: json.skipped ?? [],
        coherence: { ok: true },
      })
      loadProposals()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAnalyzing(false)
    }
  }

  const runPreview = async () => {
    setError(null)
    setApplyResult(null)
    try {
      const res = await fetch("/api/bot/ai-training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", recommendations: raw }),
      })
      const json: PreviewResponse = await res.json()
      if (!json.success) {
        setError(json.error ?? "preview failed")
        return
      }
      setPreview(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const apply = async () => {
    if (raw.length === 0) return
    setApplying(true)
    setError(null)
    try {
      const res = await fetch("/api/bot/ai-training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          recommendations: raw,
          autoApply,
        }),
      })
      const json: ApplyResponse = await res.json()
      setApplyResult(json)
      if (!json.success && json.error) setError(json.error)
      loadProposals()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const applied = preview?.applied ?? []
  const rejected = preview?.skipped ?? []
  const coherence = preview?.coherence
  const writable = applied.filter(isAutoApplicable)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">AI Training Advisor</div>
          <div className="text-xs text-muted-foreground">
            DeepSeek analyses closed trades and proposes bounded parameter changes.
          </div>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Symbol</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="BTC_USDT"
            className="h-8 w-40 rounded-lg border bg-transparent px-2.5 py-1 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Timeframe</span>
          <Select value={timeframe} onValueChange={setTimeframe}>
            <SelectItem value="Min5">Min5</SelectItem>
            <SelectItem value="Min15">Min15</SelectItem>
            <SelectItem value="Min30">Min30</SelectItem>
            <SelectItem value="Min60">Min60</SelectItem>
            <SelectItem value="Hour4">Hour4</SelectItem>
          </Select>
        </label>

        <div className="flex items-center gap-2">
          <Switch checked={autoApply} onCheckedChange={setAutoApply} />
          <span className="text-xs text-muted-foreground">
            Auto-apply on Apply (off = review only)
          </span>
        </div>

        <Button onClick={analyze} disabled={analyzing || !symbol}>
          {analyzing ? "Analysing…" : "Analyse"}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* ── Window summary ── */}
      {analysis?.analysis && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>Trades: {analysis.analysis.tradeCount}</span>
          <span>Win rate: {pct(analysis.analysis.winRate)}</span>
          <span>Avg / trade: {money(analysis.analysis.avgReturn)}</span>
        </div>
      )}

      {/* ── Proposed changes ── */}
      {preview?.success && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium">
              Proposed changes ({applied.length} would apply, {rejected.length} rejected)
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={runPreview} disabled={raw.length === 0}>
                Preview
              </Button>
              <Button
                size="sm"
                onClick={apply}
                disabled={applying || writable.length === 0}
              >
                {applying ? "Applying…" : autoApply ? "Apply" : "Record only"}
              </Button>
            </div>
          </div>

          {coherence && !coherence.ok && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Incoherent set — nothing would be written: {coherence.reason}
            </div>
          )}

          {/* Accepted: show suggested AND clamped side by side, so a value the
              guardrails narrowed is visibly narrowed rather than looking like
              what the model asked for. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Suggested</TableHead>
                <TableHead>Would apply</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applied.length === 0 && (
                <TableRow>
                  <TableCell className="text-muted-foreground" colSpan={6}>
                    No acceptable changes.
                  </TableCell>
                </TableRow>
              )}
              {applied.map((rec) => (
                <TableRow key={`ok-${rec.field}`}>
                  <TableCell className="font-medium">{rec.field}</TableCell>
                  <TableCell>{num(rec.current)}</TableCell>
                  <TableCell>{num(rec.suggested)}</TableCell>
                  <TableCell>
                    {num(rec.clamped)}
                    {rec.wasClamped && (
                      <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                        clamped
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {rec.target === "botConfig" ? "auto" : "manual"}
                  </TableCell>
                  <TableCell className="max-w-[28rem] whitespace-normal text-xs text-muted-foreground">
                    {rec.reason}
                    {rec.impact ? ` — ${rec.impact}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Rejected: this is what the panel had no way to show before. Every
              bounded-out suggestion lands here with the guardrail's reason,
              instead of silently disappearing. */}
          {rejected.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium">Rejected by guardrails</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Suggested</TableHead>
                    <TableHead>Bound / rule</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rejected.map((rec) => (
                    <TableRow key={`skip-${rec.field}`}>
                      <TableCell className="font-medium">{rec.field}</TableCell>
                      <TableCell>{num(rec.suggested)}</TableCell>
                      <TableCell className="max-w-[32rem] whitespace-normal text-xs text-muted-foreground">
                        {rec.skipReason ?? "rejected"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {applyResult && (
            <div className="rounded-lg border px-3 py-2 text-xs">
              {applyResult.appliedFields?.length ? (
                <div>Written: {applyResult.appliedFields.join(", ")}</div>
              ) : (
                <div className="text-muted-foreground">
                  Nothing written{applyResult.reason ? ` — ${applyResult.reason}` : ""}
                </div>
              )}
              {!!applyResult.proposeOnlyFields?.length && (
                <div className="text-muted-foreground">
                  Recorded for manual apply: {applyResult.proposeOnlyFields.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Stored proposals (audit trail) ── */}
      {proposals.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium">Recent proposals</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Trades</TableHead>
                <TableHead>Win rate</TableHead>
                <TableHead>Avg</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposals.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs">{fmtTime(p.analysisAt)}</TableCell>
                  <TableCell>
                    {p.symbol} <span className="text-muted-foreground">/ {p.timeframe}</span>
                  </TableCell>
                  <TableCell>{p.tradeCount}</TableCell>
                  <TableCell>{pct(p.winRate)}</TableCell>
                  <TableCell>{money(p.avgReturn)}</TableCell>
                  <TableCell className="text-xs">
                    {p.status}
                    {p.appliedAt ? ` · ${fmtTime(p.appliedAt)}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

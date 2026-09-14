"use client"

import type { BotState } from "@/lib/use-bot-state"

// Scalp validation panel. Reads ONLY the structured blocking_gate column —
// never the free-text reason (substring counting once inflated a phantom
// "kernel" bar from a descriptive log note). Rows with blocking_gate NULL
// predate the column (flow-on/multi-market old regime) and are already
// excluded server-side, so every number here describes the validated config.
const GATE_LABEL: Record<string, string> = {
  taken: "Taken",
  ml: "ML gate",
  regime: "Regime",
  risk: "Risk",
  unclassified: "Unclassified",
}

const GATE_ORDER = ["taken", "ml", "regime", "risk", "unclassified"]

export function ScalpValidationCard({ state }: { state: BotState }) {
  const v = state.scalpValidation
  if (!v || (v.byGate.length === 0 && v.byRegime.length === 0)) {
    return (
      <div className="p-4 text-xs text-muted-foreground leading-relaxed">
        No validated-config scalp data yet — rows accumulate as the tick evaluates
        scalp setups. Pre-column rows (old regime) are excluded by design.
      </div>
    )
  }

  const maxGate = Math.max(1, ...v.byGate.map((g) => g.n))
  const total = v.byGate.reduce((s, g) => s + g.n, 0)
  const taken = v.byGate.find((g) => g.gate === "taken")?.n ?? 0

  return (
    <div className="p-4 flex flex-col gap-4 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Scalp validation
        </span>
        <span className="text-[10px] text-muted-foreground">
          {taken}/{total} taken{v.since ? ` · since ${new Date(v.since).toLocaleDateString()}` : ""}
        </span>
      </div>

      {/* Rejection histogram (structured gates) */}
      <div className="flex flex-col gap-1.5">
        {GATE_ORDER.filter((gate) => v.byGate.some((g) => g.gate === gate)).map((gate) => {
          const n = v.byGate.find((g) => g.gate === gate)?.n ?? 0
          return (
            <div key={gate} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-muted-foreground">{GATE_LABEL[gate] ?? gate}</span>
              <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                <div
                  className={`h-full rounded ${gate === "taken" ? "bg-success" : gate === "unclassified" ? "bg-danger" : "bg-chart-2"}`}
                  style={{ width: `${Math.max(2, (n / maxGate) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono">{n}</span>
            </div>
          )
        })}
      </div>

      {/* Neutral-gate confirmation: resolved 4-bar outcomes by regime */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Resolved outcomes by regime
        </span>
        {v.byRegime.length === 0 && (
          <span className="text-muted-foreground">Awaiting resolved outcomes…</span>
        )}
        {v.byRegime.map((r) => (
          <div key={r.regime} className="flex items-center justify-between font-mono">
            <span className="text-muted-foreground font-sans">{r.regime}</span>
            <span>
              {r.n} setups ·{" "}
              <span className={r.net > 0 ? "text-success" : r.net < 0 ? "text-danger" : ""}>
                {r.net >= 0 ? "+" : ""}{r.net.toFixed(2)}%
              </span>
            </span>
          </div>
        ))}
        {v.byRegime.length > 0 && v.byRegime.every((r) => r.n < 20) && (
          <span className="text-muted-foreground">Small sample — treat as directional, not conclusive.</span>
        )}
      </div>
    </div>
  )
}

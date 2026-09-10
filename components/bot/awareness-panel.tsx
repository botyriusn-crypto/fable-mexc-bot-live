"use client"

import { Badge } from "@/components/ui/badge"
import type { BotState } from "@/lib/use-bot-state"

const fmt = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

const fmtSigned = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, digits)}`

export function AwarenessPanel({ state }: { state: BotState }) {
  const a = state.awareness
  if (!a) {
    return (
      <div className="p-4 text-xs text-muted-foreground leading-relaxed">
        No awareness snapshot yet — the trend-scalper has not evaluated a signal since the bot started.
      </div>
    )
  }

  const s = a.state
  const d = a.decision

  // Mirror decide()'s handoff math exactly (lib/awareness.ts).
  const trendDir = s.trend === "long" || s.trend === "short" ? s.trend : null
  const inventoryAligned =
    (trendDir === "long" && s.gridNetExposure > 0) ||
    (trendDir === "short" && s.gridNetExposure < 0)
  const netQty = s.gridAvgEntry ? Math.abs(s.gridNetExposure) / s.gridAvgEntry : 0
  const oneR = s.atr * netQty
  const pnlExceedsOneR = s.gridUnrealizedPnl > oneR

  const regimeColor =
    s.regime === "trend" ? "text-success" : s.regime === "range" ? "text-chart-2" : "text-muted-foreground"

  const actionLabel: Record<string, string> = {
    "scalp-trend": "Scalp trend",
    "grid-mean-revert": "Grid mean-revert",
    "trail-inventory": "Trail inventory — trend takes over grid",
    "stand-aside": "Stand aside",
  }

  const actionColor =
    d.action === "trail-inventory"
      ? "text-success"
      : d.action === "scalp-trend"
      ? "text-chart-2"
      : d.action === "grid-mean-revert"
      ? "text-chart-2"
      : "text-muted-foreground"

  const ago = Math.max(0, Math.round((Date.now() - a.at) / 1000))

  return (
    <div className="p-4 flex flex-col gap-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Awareness</span>
        <span className="text-[10px] text-muted-foreground">{ago}s ago</span>
      </div>

      {/* Regime + trend */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={regimeColor}>{s.regime}</Badge>
        <span className="text-muted-foreground">trend</span>
        <span className="font-mono">{s.trend}</span>
        <span className="text-muted-foreground">strength</span>
        <span className="font-mono">{Math.round(s.trendStrength * 100)}%</span>
      </div>

      {/* Handoff flow: grid -> aligned -> >1R -> trail */}
      <div className="flex items-center gap-1 text-[10px] flex-wrap">
        <span className="px-1.5 py-0.5 rounded border border-border">grid</span>
        <span className="text-muted-foreground">→</span>
        <span className={`px-1.5 py-0.5 rounded border ${inventoryAligned ? "border-success/40 text-success" : "border-border text-muted-foreground"}`}>
          aligned
        </span>
        <span className="text-muted-foreground">→</span>
        <span className={`px-1.5 py-0.5 rounded border ${pnlExceedsOneR ? "border-success/40 text-success" : "border-border text-muted-foreground"}`}>
          &gt;1R
        </span>
        <span className="text-muted-foreground">→</span>
        <span className={`px-1.5 py-0.5 rounded border ${d.action === "trail-inventory" ? "border-success/40 text-success font-medium" : "border-border text-muted-foreground"}`}>
          trail
        </span>
      </div>

      {/* Grid inventory */}
      <div className="rounded-md border p-2 flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Grid net exposure</span>
          <span className="font-mono">{fmtSigned(s.gridNetExposure)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Avg entry</span>
          <span className="font-mono">{fmt(s.gridAvgEntry)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Unrealized PnL</span>
          <span className={`font-mono ${s.gridUnrealizedPnl >= 0 ? "text-success" : "text-danger"}`}>
            {fmtSigned(s.gridUnrealizedPnl)}
          </span>
        </div>
      </div>

      {/* Handoff checks */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Inventory aligned with trend</span>
          <span className={inventoryAligned ? "text-success" : "text-muted-foreground"}>
            {inventoryAligned ? "yes" : "no"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">PnL &gt; 1R buffer</span>
          <span className={pnlExceedsOneR ? "text-success" : "text-muted-foreground"}>
            {pnlExceedsOneR ? "yes" : "no"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">1R buffer</span>
          <span className="font-mono">{fmt(oneR)}</span>
        </div>
      </div>

      {/* Scalp + ML gate */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Scalp signal</span>
          <span className="font-mono">
            {s.scalp?.triggered ? `${s.scalp.direction} ${Math.round(s.scalp.confidence * 100)}%` : "none"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">ML gate</span>
          <span className={s.mlAllowed ? "text-success" : "text-danger"}>{s.mlAllowed ? "allowed" : "blocked"}</span>
        </div>
      </div>

      {/* Decision */}
      <div className="rounded-md border p-2 flex items-center justify-between">
        <span className="text-muted-foreground">Decision</span>
        <span className={`font-medium ${actionColor}`}>{actionLabel[d.action] ?? d.action}</span>
      </div>

      {d.reason && <div className="text-[10px] text-muted-foreground leading-relaxed">{d.reason}</div>}
    </div>
  )
}

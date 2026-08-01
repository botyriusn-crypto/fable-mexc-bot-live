"use client"

import { useState } from "react"
import { mutate } from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { botAction, updateConfig, type BotState } from "@/lib/use-bot-state"

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function GridCard({ state }: { state: BotState }) {
  const cfg = state.config
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState(String(cfg.gridLevels))
  const [budgetPct, setBudgetPct] = useState(String(cfg.gridBudgetPct))
  const [rangeAtr, setRangeAtr] = useState(String(cfg.gridRangeAtrMult))
  const [feeMargin, setFeeMargin] = useState(String(cfg.gridFeeMarginMult))

  const toggle = async (on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await botAction(on ? "grid_on" : "grid_off")
      await mutate("/api/bot/state")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grid toggle failed")
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    setBusy(true)
    setError(null)
    try {
      const updates: Record<string, number> = {}
      const l = Number(levels)
      const b = Number(budgetPct)
      const r = Number(rangeAtr)
      const f = Number(feeMargin)
      if (Number.isFinite(l) && l >= 2 && l <= 50) updates.gridLevels = Math.round(l)
      if (Number.isFinite(b) && b > 0 && b <= 100) updates.gridBudgetPct = b
      if (Number.isFinite(r) && r > 0) updates.gridRangeAtrMult = r
      if (Number.isFinite(f) && f >= 1 && f <= 10) updates.gridFeeMarginMult = f
      await updateConfig(updates)
      await mutate("/api/bot/state")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed")
    } finally {
      setBusy(false)
    }
  }

  const totalPnl = state.grid.realizedPnl + state.grid.unrealizedPnl

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium">Grid Bot</CardTitle>
        <div className="flex items-center gap-2">
          {cfg.gridEnabled && cfg.gridPaused && (
            <Badge variant="outline" className="border-chart-3/40 bg-chart-3/15 text-chart-3 text-[10px]">
              PAUSED (TREND)
            </Badge>
          )}
          <Switch
            checked={cfg.gridEnabled}
            onCheckedChange={toggle}
            disabled={busy}
            aria-label="Toggle grid bot"
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-xs text-danger">{error}</p>}

        {cfg.gridEnabled ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <div className="font-mono text-sm font-semibold">
                  {cfg.gridLower != null && cfg.gridUpper != null
                    ? `${fmt(cfg.gridLower, 0)} – ${fmt(cfg.gridUpper, 0)}`
                    : "Setting up…"}
                </div>
                <div className="text-xs text-muted-foreground">Range</div>
              </div>
              <div>
                <div className="font-mono text-sm font-semibold">
                  {cfg.gridSpacing != null ? fmt(cfg.gridSpacing, 2) : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Spacing · {cfg.gridEffectiveLevels ?? "—"}/{cfg.gridLevels} levels
                </div>
              </div>
              <div>
                <div
                  className={`font-mono text-sm font-semibold ${state.grid.unrealizedPnl > 0 ? "text-success" : state.grid.unrealizedPnl < 0 ? "text-danger" : ""}`}
                >
                  {state.grid.unrealizedPnl >= 0 ? "+" : ""}
                  {fmt(state.grid.unrealizedPnl)}
                </div>
                <div className="text-xs text-muted-foreground">Unrealized</div>
              </div>
              <div>
                <div
                  className={`font-mono text-sm font-semibold ${totalPnl > 0 ? "text-success" : totalPnl < 0 ? "text-danger" : ""}`}
                >
                  {totalPnl >= 0 ? "+" : ""}
                  {fmt(totalPnl)}
                </div>
                <div className="text-xs text-muted-foreground">Grid PnL (total)</div>
              </div>
            </div>

            {state.grid.orders.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Active levels</span>
                <div className="flex flex-wrap gap-1">
                  {state.grid.orders.map((o) => (
                    <Badge
                      key={o.id}
                      variant="outline"
                      className={
                        o.side === "sell"
                          ? "border-danger/40 bg-danger/10 font-mono text-[10px] text-danger"
                          : "border-success/40 bg-success/10 font-mono text-[10px] text-success"
                      }
                    >
                      {o.side === "sell" ? "S" : "B"} {fmt(o.price, 0)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Places a ladder of buy orders below price with paired sell targets above — profits from
              oscillation in ranging markets. Auto-pauses when the regime turns trending. Uses{" "}
              {cfg.gridBudgetPct}% of balance as its own budget.
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="grid-levels" className="text-xs text-muted-foreground">
                  Levels
                </Label>
                <Input
                  id="grid-levels"
                  value={levels}
                  onChange={(e) => setLevels(e.target.value)}
                  className="h-8 font-mono text-xs"
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="grid-budget" className="text-xs text-muted-foreground">
                  Budget %
                </Label>
                <Input
                  id="grid-budget"
                  value={budgetPct}
                  onChange={(e) => setBudgetPct(e.target.value)}
                  className="h-8 font-mono text-xs"
                  inputMode="decimal"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="grid-range" className="text-xs text-muted-foreground">
                  Range (ATR x)
                </Label>
                <Input
                  id="grid-range"
                  value={rangeAtr}
                  onChange={(e) => setRangeAtr(e.target.value)}
                  className="h-8 font-mono text-xs"
                  inputMode="decimal"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="grid-fee-margin" className="text-xs text-muted-foreground">
                  Fee safety x
                </Label>
                <Input
                  id="grid-fee-margin"
                  value={feeMargin}
                  onChange={(e) => setFeeMargin(e.target.value)}
                  className="h-8 font-mono text-xs"
                  inputMode="decimal"
                />
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={saveSettings} disabled={busy} className="self-start">
              Save grid settings
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

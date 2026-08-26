"use client"
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DEFAULT_ADVANCED_CONFIG, type AdvancedConfig } from "@/lib/advanced-strategy"

export function AdvancedSettingsPanel() {
  const [cfg, setCfg] = useState<AdvancedConfig>(DEFAULT_ADVANCED_CONFIG)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof AdvancedConfig>(key: K, value: AdvancedConfig[K]) =>
    setCfg((c) => ({ ...c, [key]: value }))

  const save = async () => {
    setSaving(true)
    try {
      await fetch("/api/bot/advanced-strategy/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced Strategy Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Enable advanced strategy
        </label>

        <fieldset className="space-y-2 border rounded p-3">
          <legend className="px-1 text-xs font-semibold">Multi-timeframe</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.mtfEnabled}
              onChange={(e) => set("mtfEnabled", e.target.checked)}
            />
            Require HTF alignment
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Min alignment</span>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={cfg.mtfMinAlignment}
              onChange={(e) => set("mtfMinAlignment", Number(e.target.value))}
              className="w-20 border rounded px-1"
            />
          </label>
        </fieldset>

        <fieldset className="space-y-2 border rounded p-3">
          <legend className="px-1 text-xs font-semibold">Smart money</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.smartMoneyEnabled}
              onChange={(e) => set("smartMoneyEnabled", e.target.checked)}
            />
            Require smart-money confirmation
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Funding long threshold</span>
            <input
              type="number"
              step="0.0001"
              value={cfg.fundingLongThreshold}
              onChange={(e) => set("fundingLongThreshold", Number(e.target.value))}
              className="w-24 border rounded px-1"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Funding short threshold</span>
            <input
              type="number"
              step="0.0001"
              value={cfg.fundingShortThreshold}
              onChange={(e) => set("fundingShortThreshold", Number(e.target.value))}
              className="w-24 border rounded px-1"
            />
          </label>
        </fieldset>

        <fieldset className="space-y-2 border rounded p-3">
          <legend className="px-1 text-xs font-semibold">Dynamic sizing</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.dynamicSizingEnabled}
              onChange={(e) => set("dynamicSizingEnabled", e.target.checked)}
            />
            Confidence-scaled sizing
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Base risk %</span>
            <input
              type="number"
              step="0.001"
              value={cfg.baseRiskPct}
              onChange={(e) => set("baseRiskPct", Number(e.target.value))}
              className="w-20 border rounded px-1"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Max risk %</span>
            <input
              type="number"
              step="0.001"
              value={cfg.maxRiskPct}
              onChange={(e) => set("maxRiskPct", Number(e.target.value))}
              className="w-20 border rounded px-1"
            />
          </label>
        </fieldset>

        <button
          onClick={save}
          disabled={saving}
          className="w-full rounded bg-primary text-primary-foreground px-3 py-2 font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </CardContent>
    </Card>
  )
}

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { botAction, updateConfig, type BotState } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"

interface FieldDef {
  key: string
  label: string
  step?: string
}

const STRATEGY_FIELDS: FieldDef[] = [
  { key: "emaFast", label: "EMA fast" },
  { key: "emaSlow", label: "EMA slow" },
  { key: "rsiPeriod", label: "RSI period" },
  { key: "rsiOverbought", label: "RSI overbought" },
  { key: "rsiOversold", label: "RSI oversold" },
  { key: "atrPeriod", label: "ATR period" },
]

const REGIME_FIELDS: FieldDef[] = [
  { key: "adxTrendThreshold", label: "ADX trend ≥", step: "1" },
  { key: "adxRangeThreshold", label: "ADX range ≤", step: "1" },
  { key: "bbPeriod", label: "BB period" },
  { key: "bbStd", label: "BB std dev", step: "0.1" },
]

const STRATEGY_MODES = [
  { value: "auto", label: "Auto (regime switch)" },
  { value: "trend", label: "Trend only" },
  { value: "range", label: "Range only" },
] as const

const EXIT_FIELDS: FieldDef[] = [
  { key: "slAtrMult", label: "SL (x ATR)", step: "0.1" },
  { key: "tpAtrMult", label: "TP (x ATR)", step: "0.1" },
  { key: "trailAtrMult", label: "Trail (x ATR)", step: "0.1" },
  { key: "momentumThreshold", label: "Momentum trigger", step: "0.05" },
]

const ML_FIELDS: FieldDef[] = [
  { key: "mlConfidenceThreshold", label: "Logistic confidence", step: "0.05" },
  { key: "mlLearningRate", label: "Learning rate", step: "0.01" },
]

const LORENTZIAN_FIELDS: FieldDef[] = [
  { key: "lorentzianConfidenceThreshold", label: "Minimum confidence", step: "0.05" },
  { key: "lorentzianNeighbors", label: "Neighbors", step: "1" },
  { key: "lorentzianLookback", label: "Closed-bar lookback", step: "20" },
  { key: "lorentzianAdxThreshold", label: "ADX threshold", step: "1" },
]

const CONFIRMATION_MODES = [
  { value: "observe", label: "Observe" },
  { value: "logistic", label: "Logistic" },
  { value: "lorentzian", label: "Lorentzian" },
  { value: "both", label: "Both" },
] as const

const AI_SCHEDULES = [
  { value: "manual", label: "Manual Only" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const

const EXCHANGES = [
  { value: "mexc", label: "MEXC" },
  { value: "gate", label: "Gate.io" },
  { value: "bybit", label: "Bybit" },
] as const

const SIZE_FIELDS: FieldDef[] = [{ key: "positionSizeUsdt", label: "Position size (USDT)" }]
const SNIPER_FIELDS: FieldDef[] = [
  { key: "sniperMaxEntries", label: "Sniper max entries", step: "1" },
  { key: "sniperPositionSizeUsdt", label: "Sniper position size (USDT)" },
  { key: "sniperLeverage", label: "Sniper leverage", step: "1" },
  { key: "sniperConfidenceFloor", label: "Sniper min confidence", step: "0.05" },
  { key: "sniperCorrThreshold", label: "Sniper correlation threshold", step: "0.05" },
  { key: "sniperSigmaExtreme", label: "Sniper sigma extreme", step: "0.1" },
  { key: "sniperVolumeSurgeMult", label: "Sniper volume surge ×", step: "0.1" },
  { key: "sniperMinVolumeUsdt", label: "Sniper min volume (USDT)" },
  { key: "sniperTargetRiskUsdt", label: "Sniper target risk (USDT)", step: "0.5" },
    { key: "sniperMinStopPct", label: "Sniper min stop distance (%)", step: "0.1", multiplier: 100 },
    { key: "sniperTpSlRatio", label: "Sniper TP:SL ratio (R)", step: "0.5" },
]

const TREND_RIDER_FIELDS: FieldDef[] = [
  { key: "trendRiderPositionSizeUsdt", label: "Position size (USDT)" },
  { key: "trendRiderLeverage", label: "Leverage", step: "1" },
  { key: "trendRiderPullbackAtr", label: "Pullback depth (× ATR)", step: "0.1" },
  { key: "trendRiderMinTrendAge", label: "Min trend age (4H candles)", step: "1" },
  { key: "trendRiderChandelierMult", label: "Chandelier trail (× ATR)", step: "0.5" },
  { key: "trendRiderRegimeAdxMin", label: "Regime ADX floor (daily)", step: "1" },
]

export function SettingsPanel({ state }: { state: BotState }) {
  const { mutate } = useSWRConfig()
  const cfg = state.config
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [aiResult, setAiResult] = useState<any>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [confirmLive, setConfirmLive] = useState(false)

  const value = (key: string) =>
    form[key] ?? String((cfg as unknown as Record<string, unknown>)[key] ?? "")

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updates: Record<string, unknown> = {}
      for (const [key, rawValue] of Object.entries(form)) {
        const numericValue = Number(rawValue)
        if (Number.isFinite(numericValue)) updates[key] = numericValue
      }
      if (Object.keys(updates).length > 0) {
        await updateConfig(updates)
        setForm({})
        await mutate("/api/bot/status")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const toggleBool = async (key: string, checked: boolean) => {
    try {
      await updateConfig({ [key]: checked })
      await mutate("/api/bot/status")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed")
    }
  }

  const handleModeSwitch = async (live: boolean) => {
    setError(null)
    if (live && !confirmLive) {
      setConfirmLive(true)
      return
    }
    setConfirmLive(false)
    try {
      await botAction("set_mode", { mode: live ? "live" : "paper" })
      await mutate("/api/bot/status")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mode switch failed")
    }
  }

  const handleReset = async () => {
    setError(null)
    try {
      await botAction("reset_paper")
      await mutate("/api/bot/status")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed")
    }
  }

  const renderFields = (fields: FieldDef[]) => (
    <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <Label htmlFor={f.key} className="text-xs text-muted-foreground">
            {f.label}
          </Label>
          <Input
            id={f.key}
            type="number"
            step={f.step ?? "1"}
            value={value(f.key)}
            onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
            className="h-8 font-mono text-xs"
          />
        </div>
      ))}
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Strategy Settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-muted-foreground block">🎯 Trend Rider</span>
            <span className="text-xs leading-relaxed text-muted-foreground">4H trend detection + 15m entry + daily regime gate</span>
          </div>
          <Switch
            id="trendRiderEnabled"
            checked={Boolean(cfg.trendRiderEnabled)}
            onCheckedChange={(c) => toggleBool("trendRiderEnabled", c)}
          />
        </div>
        {cfg.trendRiderEnabled && renderFields(TREND_RIDER_FIELDS)}
        {cfg.trendRiderEnabled && (
          <div className="flex items-center justify-between">
            <Label htmlFor="trendRiderRegimeGate" className="text-xs text-muted-foreground">
              Regime gate (sit out ranging coins)
            </Label>
            <Switch
              id="trendRiderRegimeGate"
              checked={Boolean(cfg.trendRiderRegimeGate)}
              onCheckedChange={(c) => toggleBool("trendRiderRegimeGate", c)}
            />
          </div>
        )}
        <Separator />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-xs font-medium text-muted-foreground block">AI Training Advisor</span>
              <span className="text-xs leading-relaxed text-muted-foreground">DeepSeek analyzes trades and suggests tweaks</span>
            {aiError && <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger mt-1">{aiError}</div>}
            {aiResult?.recommendations?.length > 0 && (
              <div className="space-y-1 rounded-md border border-success/40 bg-success/10 p-2 mt-1">
                <span className="text-xs font-medium text-success">AI Recommendations</span>
                {aiResult.recommendations.map((rec: any, i: number) => (
                  <div key={i} className="text-xs"><span className="font-medium">{rec.field}:</span> {String(rec.current)} → {String(rec.suggested)} — {rec.reason}</div>
                ))}
                <Button size="sm" variant="default" className="h-6 px-2 text-xs mt-1" disabled={applying} onClick={async () => {
                  setApplying(true); setAiError(null)
                  try {
                    const res = await fetch("/api/bot/ai-apply", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ recommendations: aiResult.recommendations }),
                    })
                    const data = await res.json()
                    if (data.error) { setAiError(data.error) }
                    else { setAiResult(null); await mutate("/api/bot/status") }
                  } catch (err) { setAiError(err instanceof Error ? err.message : "Apply failed") }
                  finally { setApplying(false) }
                }}>{applying ? "Applying…" : "Apply Recommendations"}</Button>
              </div>
            )}
            </div>
            <Switch
              id="aiAdvisor"
              checked={Boolean(cfg.aiAdvisorEnabled)}
              onCheckedChange={(checked) => toggleBool("aiAdvisorEnabled", checked)}
            />
          </div>
          {cfg.aiAdvisorEnabled && (
            <div className="flex flex-col gap-2 mt-2">
              <span className="text-xs font-medium text-muted-foreground">Analysis Schedule</span>
              <Button size="sm" variant="secondary" className="h-6 px-2 text-xs ml-auto" onClick={async () => {
                setAnalyzing(true); setAiResult(null); setAiError(null)
                try {
                  const res = await fetch("/api/bot/ai-analyze", { method: "POST" })
                  const data = await res.json()
                  data.error ? setAiError(data.error) : setAiResult(data)
                } catch (err) { setAiError(err instanceof Error ? err.message : "Analysis failed") }
                finally { setAnalyzing(false) }
              }}>{analyzing ? "..." : "Run Analysis"}</Button>
              <div className="grid grid-cols-3 gap-1">
                {AI_SCHEDULES.map((schedule) => (
                  <Button
                    key={schedule.value}
                    size="sm"
                    variant={cfg.aiAnalysisSchedule === schedule.value ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    onClick={async () => {
                      try {
                        await updateConfig({ aiAnalysisSchedule: schedule.value })
                        await mutate("/api/bot/status")
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Update failed")
                      }
                    }}
                  >
                    {schedule.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
        <Separator />
        {renderFields(SIZE_FIELDS)}

        <div className="flex items-center justify-between">
          <Label htmlFor="allow-long" className="text-xs text-muted-foreground">
            Allow longs
          </Label>
          <Switch id="allow-long" checked={cfg.allowLong} onCheckedChange={(c) => toggleBool("allowLong", c)} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="allow-short" className="text-xs text-muted-foreground">
            Allow shorts
          </Label>
          <Switch id="allow-short" checked={cfg.allowShort} onCheckedChange={(c) => toggleBool("allowShort", c)} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="sniper-live" className="text-xs text-muted-foreground">
            Sniper live
          </Label>
          <Switch id="sniper-live" checked={Boolean(cfg.sniperLive)} onCheckedChange={(c) => toggleBool("sniperLive", c)} />
        </div>
        {renderFields(SNIPER_FIELDS)}

        <Button size="sm" onClick={handleSave} disabled={saving || Object.keys(form).length === 0}>
          {saving ? "Saving…" : "Save Settings"}
        </Button>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex flex-col">
            <Label className="text-xs font-medium">Exchange / API</Label>
            <span className="text-xs text-muted-foreground">Select trading venue</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {EXCHANGES.map((ex) => (
              <Button
                key={ex.value}
                size="sm"
                variant={cfg.exchange === ex.value ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                disabled={cfg.status === "running"}
                onClick={async () => {
                  try {
                    await updateConfig({ exchange: ex.value })
                    await mutate("/api/bot/status")
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Exchange update failed")
                  }
                }}
              >
                {ex.label}
              </Button>
            ))}
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label htmlFor="live-mode" className="text-xs font-medium">
              Live trading
            </Label>
            <span className="text-xs text-muted-foreground">Routes real orders to {EXCHANGES.find(e => e.value === cfg.exchange)?.label || 'exchange'}</span>
          </div>
          <Switch id="live-mode" checked={cfg.mode === "live"} onCheckedChange={handleModeSwitch} />
        </div>

        {confirmLive && (
          <div className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 p-3">
            <p className="text-xs leading-relaxed text-danger">
              Live mode places real orders with real funds using your {EXCHANGES.find(e => e.value === cfg.exchange)?.label || 'exchange'} API keys. Confirm to proceed.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => handleModeSwitch(true)}>
                Enable Live Trading
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmLive(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <Button size="sm" variant="outline" onClick={handleReset}>
          Reset Paper Account
        </Button>

        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  )
}

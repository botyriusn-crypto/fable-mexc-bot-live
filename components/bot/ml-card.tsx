"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { BotState } from "@/lib/use-bot-state"

const FEATURE_LABELS: Record<string, string> = {
  emaSpread: "EMA spread",
  crossover: "Crossover",
  rsi: "RSI",
  macdHist: "MACD hist",
  atrPct: "Volatility (ATR)",
  roc: "Momentum (ROC)",
  adx: "Trend (ADX)",
  volSurge: "Volume surge",
  sideLong: "Long bias",
}

export function MlCard({ state }: { state: BotState }) {
  const model = state.model

  if (!model) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">ML Model</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Model not initialized</CardContent>
      </Card>
    )
  }

  const weights = Object.entries(model.weights ?? {})
  const maxAbs = Math.max(0.05, ...weights.map(([, v]) => Math.abs(v)))
  const learning = model.sampleCount < 30

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">ML Model</CardTitle>
        <span className="text-xs text-muted-foreground">
          {learning ? `Learning phase · ${model.sampleCount}/30 trades` : `${model.sampleCount} trades learned`}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted px-2 py-2">
            <div className="font-mono text-lg font-semibold">{model.sampleCount}</div>
            <div className="text-xs text-muted-foreground">Trades trained</div>
          </div>
          <div className="rounded-md bg-muted px-2 py-2">
            <div className="font-mono text-lg font-semibold">
              {(model.rollingAccuracy * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-muted-foreground">Accuracy</div>
          </div>
          <div className="rounded-md bg-muted px-2 py-2">
            <div className="font-mono text-lg font-semibold">
              {(state.config.mlConfidenceThreshold * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-muted-foreground">Threshold</div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Learned feature weights</span>
          {weights.map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate text-muted-foreground">
                {FEATURE_LABELS[key] ?? key}
              </span>
              <div className="relative h-2 flex-1 rounded-full bg-muted">
                <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
                <div
                  className={`absolute top-0 h-full rounded-full ${value >= 0 ? "bg-success" : "bg-danger"}`}
                  style={{
                    left: value >= 0 ? "50%" : `${50 - (Math.abs(value) / maxAbs) * 50}%`,
                    width: `${(Math.abs(value) / maxAbs) * 50}%`,
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono">{value.toFixed(3)}</span>
            </div>
          ))}
        </div>

        {learning && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            The model starts neutral and defers to indicator signals. Every closed trade trains it —
            confidence gating strengthens as samples accumulate.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

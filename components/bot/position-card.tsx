"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { botAction, type BotState } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"

const fmt = (value: number | null | undefined, digits = 2) =>
  value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits })

const fmtPrice = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 6 })

export function PositionCard({ state }: { state: BotState }) {
  const { mutate } = useSWRConfig()
  const [closingId, setClosingId] = useState<number | null>(null)

  const closePosition = async (positionId: number) => {
    setClosingId(positionId)
    try {
      await botAction("close_position", { positionId })
      await mutate("/api/bot/state")
    } finally {
      setClosingId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Managed Exposure</CardTitle>
        <Badge variant="outline">{state.exposures.length} open</Badge>
      </CardHeader>
      <CardContent>
        {state.exposures.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No open position — waiting for a signal
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {state.exposures.map(({ position, markPrice, unrealizedPnl, selected }) => {
              const isLong = position.side === "long"
              const pnlPct = position.sizeUsdt > 0 ? (unrealizedPnl / position.sizeUsdt) * 100 : 0
              return (
                <article key={position.id} className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{(position?.symbol || "UNKNOWN").replace("_", "/")}</span>
                        <Badge variant="secondary" className="font-mono text-xs">{position.timeframe}</Badge>
                        {selected ? <Badge className="bg-primary text-primary-foreground">Selected</Badge> : <Badge variant="outline">Legacy</Badge>}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {(position?.side || "unknown").toUpperCase()} {position.leverage}x · entry {fmtPrice(position.entryPrice)} · mark {fmtPrice(markPrice)}
                      </span>
                    </div>
                    <Badge
                      variant="outline"
                      className={isLong ? "border-success/30 bg-success/15 text-success" : "border-danger/30 bg-danger/15 text-danger"}
                    >
                      {(position?.side || "unknown").toUpperCase()}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3">
                    <div>
                      <div className={`font-mono text-lg font-semibold ${unrealizedPnl >= 0 ? "text-success" : "text-danger"}`}>
                        {unrealizedPnl >= 0 ? "+" : ""}{fmt(unrealizedPnl)} USDT
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{pnlPct >= 0 ? "+" : ""}{fmt(pnlPct)}%</div>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={closingId === position.id}
                      onClick={() => closePosition(position.id)}
                    >
                      {closingId === position.id ? "Closing…" : "Close"}
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

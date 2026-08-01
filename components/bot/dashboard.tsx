"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useBotState, botAction } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"
import { PriceChart, EquityChart } from "./charts"
import { PositionCard } from "./position-card"
import { MlCard } from "./ml-card"
import { TradesTable } from "./trades-table"
import { ActivityLog } from "./activity-log"
import { SettingsPanel } from "./settings-panel"
import { MultiGridCard } from "./multi-grid-card"
import { PerformanceAnalyzer } from "./performance-analyzer"
import { MarketBar } from "./market-bar"
import { ClassifierCard } from "./classifier-card"

const fmt = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 px-4 py-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`font-mono text-lg font-semibold ${tone === "pos" ? "text-success" : tone === "neg" ? "text-danger" : ""}`}>{value}</span>
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const { data: state, error, mutate: refresh } = useBotState()
  const { mutate } = useSWRConfig()
  const [toggling, setToggling] = useState(false)

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-md">
          <CardContent className="flex flex-col gap-2 p-6">
            <h2 className="font-semibold">Failed to load bot state</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{error.message}</p>
            <Button size="sm" onClick={() => refresh()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!state) {
    return <div className="flex min-h-screen items-center justify-center"><span className="text-sm text-muted-foreground">Loading dashboard…</span></div>
  }

  const running = state.config.status === "running"
  const isLive = state.config.mode === "live"
  const exchangeName = state.config.exchange || "mexc"
  const exchangeLabel = { mexc: "MEXC", gate: "Gate.io", bybit: "Bybit" }[exchangeName] || exchangeName.toUpperCase()

  const toggleBot = async () => {
    setToggling(true)
    try {
      await botAction(running ? "stop" : "start")
      await mutate("/api/bot/state")
    } finally { setToggling(false) }
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{exchangeLabel} Futures Bot</h1>
          <Badge variant="outline" className={isLive ? "border-danger/40 bg-danger/15 text-danger" : "border-chart-2/40 bg-chart-2/15 text-chart-2"}>{isLive ? "LIVE" : "PAPER"}</Badge>
          <Badge variant="outline" className={running ? "border-success/40 bg-success/15 text-success" : "border-border bg-muted text-muted-foreground"}>
            <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-success" : "bg-muted-foreground"}`} />{running ? "RUNNING" : "STOPPED"}
          </Badge>
          {state.regime && (
            <Badge variant="outline" className={state.regime === "trend" ? "border-chart-3/40 bg-chart-3/15 text-chart-3" : state.regime === "range" ? "border-chart-2/40 bg-chart-2/15 text-chart-2" : "border-border bg-muted text-muted-foreground"} title={state.adxValue != null ? `ADX ${state.adxValue.toFixed(1)}` : undefined}>
              {state.regime === "trend" ? "TRENDING" : state.regime === "range" ? "RANGING" : "NEUTRAL"}
              {state.adxValue != null && <span className="ml-1 font-mono opacity-70">{state.adxValue.toFixed(0)}</span>}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {state.ticker && (
            <span className="font-mono text-sm text-muted-foreground">
              {state.config.symbol} <span className="text-foreground">{fmt(state.ticker.lastPrice)}</span>{" "}
              <span className={state.ticker.riseFallRate >= 0 ? "text-success" : "text-danger"}>{state.ticker.riseFallRate >= 0 ? "+" : ""}{(state.ticker.riseFallRate * 100).toFixed(2)}%</span>
            </span>
          )}
          <Button size="sm" variant={running ? "destructive" : "default"} onClick={toggleBot} disabled={toggling}>{toggling ? "…" : running ? "Stop Bot" : "Start Bot"}</Button>
        </div>
      </header>

      <MarketBar state={state} />

      {(() => {
        const live = isLive && state.liveAccount && !("error" in state.liveAccount) ? state.liveAccount : null
        const liveError = isLive && state.liveAccount && "error" in state.liveAccount ? state.liveAccount.error : null
        const equity = live ? live.equity : state.equity
        const balance = live ? live.availableBalance : state.config.paperBalance
        const upnl = live ? live.unrealized : state.unrealizedPnl
        const lifetime = (state as any).lifetimeStats
        const totalPnl = lifetime?.totalPnl ?? 0
        const totalTradesCount = lifetime?.totalTrades ?? 0
        const historicWinRate = lifetime?.winRate ?? 0
        return (
          <>
            {liveError && <Card className="border-danger/40"><CardContent className="px-4 py-2 text-xs text-danger">Live account balance unavailable: {liveError}. Showing tracked values instead.</CardContent></Card>}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label={live ? "Equity (live)" : "Equity"} value={`${fmt(equity)} USDT`} />
              <Stat label={live ? "Available (live)" : "Balance"} value={`${fmt(balance)} USDT`} />
              <Stat label="Unrealized PnL" value={`${upnl >= 0 ? "+" : ""}${fmt(upnl)}`} tone={upnl > 0 ? "pos" : upnl < 0 ? "neg" : undefined} />
              <Stat label="Historic PnL" value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`} tone={totalPnl > 0 ? "pos" : totalPnl < 0 ? "neg" : undefined} />
              <Stat label="Win Rate" value={totalTradesCount > 0 ? `${(historicWinRate * 100).toFixed(0)}%` : "—"} />
              <Stat label="Trades" value={String(totalTradesCount)} />
            </div>
          </>
        )
      })()}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PriceChart state={state} />
        <EquityChart state={state} />
      </div>

      <MultiGridCard />
      <PerformanceAnalyzer />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <PositionCard state={state} />
          <ClassifierCard state={state} />
          <MlCard state={state} />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-1">
          <TradesTable state={state} />
          <ActivityLog state={state} />
        </div>
        <SettingsPanel state={state} />
      </div>
    </main>
  )
}

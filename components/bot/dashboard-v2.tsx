"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useBotState, botAction } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"
import { PriceChart, EquityChart } from "./charts"
import { PositionCard } from "./position-card"
import { TradesTable } from "./trades-table"
import { ActivityLog } from "./activity-log"
import { SettingsPanel } from "./settings-panel"
import { SniperAlertBubble, SniperCommand } from "./sniper-alerts"
import { AdvisorCard } from "./advisor-card"
import { MultiGridCard } from "./multi-grid-card"
import { PerformanceAnalyzer } from "./performance-analyzer"
import { MarketBar } from "./market-bar"
import { MlCard } from "./ml-card"
import { ClassifierCard } from "./classifier-card"
import { ChevronUp, X, ExternalLink, ChevronDown, ChevronRight } from "lucide-react"

const fmt = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

// ======================== TERMINAL PANEL ========================
function TerminalPanel({ state, isOpen, onToggle }: { state: any; isOpen: boolean; onToggle: () => void }) {
  const [activeTab, setActiveTab] = useState<"history" | "logs" | "performance">("history")
  const [isFloating, setIsFloating] = useState(false)

  const terminalContent = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 shrink-0">
        <div className="flex gap-1">
          {(["history", "logs", "performance"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "history" ? "Trade History" : tab === "logs" ? "Logs" : "Performance"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setIsFloating(!isFloating)}
          className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
          title="Pop out"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {activeTab === "history" && <TradesTable state={state} />}
        {activeTab === "logs" && <ActivityLog state={state} />}
        {activeTab === "performance" && <PerformanceAnalyzer />}
      </div>
    </div>
  )

  return (
    <>
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 transition-transform duration-300 ease-in-out ${
          isOpen ? "translate-y-0" : "translate-y-[calc(100%-28px)]"
        }`}
        style={{ height: "40vh" }}
      >
        <button
          onClick={onToggle}
          className="w-full h-7 bg-card border-t border-x rounded-t-lg flex items-center justify-center gap-2 hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <ChevronUp className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
          <span className="text-xs text-muted-foreground font-medium">📊 Terminal</span>
        </button>
        <div className="h-[calc(40vh-28px)] bg-card border-x border-b overflow-hidden">
          {terminalContent}
        </div>
      </div>

      {isFloating && (
        <div className="fixed inset-4 z-[100] bg-card border rounded-lg shadow-2xl overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b px-4 py-2 bg-muted/30">
            <span className="text-sm font-medium">Terminal</span>
            <button onClick={() => setIsFloating(false)} className="p-1 hover:bg-muted rounded">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">{terminalContent}</div>
        </div>
      )}
    </>
  )
}

// ======================== STAT CARD ========================
function StatCard({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" | "neutral" }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border bg-card p-3 min-w-[110px]">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-lg font-bold font-mono mt-0.5 ${
        tone === "pos" ? "text-success" : tone === "neg" ? "text-danger" : "text-foreground"
      }`}>
        {value}
      </span>
    </div>
  )
}

// ======================== COLLAPSIBLE SECTION ========================
function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true)

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/30 w-full bg-card"
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
      </button>
      {isOpen && <div className="border-t">{children}</div>}
    </div>
  )
}

// ======================== MAIN DASHBOARD ========================
export function DashboardV2() {
  const { data: state, error, mutate: refresh } = useBotState()
  const { mutate } = useSWRConfig()
  const [toggling, setToggling] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
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
    return <div className="flex h-screen items-center justify-center"><span className="text-sm text-muted-foreground">Loading dashboard…</span></div>
  }

  const running = state.config.status === "running"
  const isLive = state.config.mode === "live"
  const exchangeName = state.config.exchange || "mexc"
  const exchangeLabel = { mexc: "MEXC", gate: "Gate.io", bybit: "Bybit" }[exchangeName] || exchangeName.toUpperCase()
  const live = isLive && state.liveAccount && !("error" in state.liveAccount) ? state.liveAccount : null
  const balance = live ? live.availableBalance : state.config.paperBalance
  const equity = live ? live.equity : state.equity
  const upnl = live ? live.unrealized : state.unrealizedPnl
  const lifetime = (state as any).lifetimeStats
  const totalPnl = lifetime?.totalPnl ?? 0
  const winRate = lifetime?.winRate ?? 0
  const totalTrades = lifetime?.totalTrades ?? 0

  const grids = (state as any).gridConfigs || []
  const totalRealized = totalPnl
  const STARTING_BALANCE = 9819.74
  const phantomPnl = balance - (totalRealized + STARTING_BALANCE)
  const totalUnrealized = grids.reduce((s: number, g: any) => s + (g.unrealizedPnl || 0), 0)

  const pnlTone = (v: number) => v > 0 ? "pos" : v < 0 ? "neg" : "neutral"

  const toggleBot = async () => {
    setToggling(true)
    try {
      await botAction(running ? "stop" : "start")
      await mutate("/api/bot/state")
    } finally { setToggling(false) }
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* ========== ZONE 1: HEADER ========== */}
      <header className="h-11 border-b flex items-center justify-between px-4 shrink-0 bg-card/50 z-10">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tracking-tight">{exchangeLabel}</span>
          <Badge variant="outline" className={isLive ? "border-danger/40 bg-danger/15 text-danger text-[10px] px-1.5" : "border-chart-2/40 bg-chart-2/15 text-chart-2 text-[10px] px-1.5"}>
            {isLive ? "LIVE" : "PAPER"}
          </Badge>
          <Badge variant="outline" className={running ? "border-success/40 bg-success/15 text-success text-[10px] px-1.5" : "border-border bg-muted text-muted-foreground text-[10px] px-1.5"}>
            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-success" : "bg-muted-foreground"}`} />
            {running ? "RUN" : "STOP"}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant={running ? "destructive" : "default"} onClick={toggleBot} disabled={toggling} className="h-6 text-[10px] px-2">
            {toggling ? "…" : running ? "Stop Bot" : "Start Bot"}
          </Button>
        </div>
      </header>

      {/* ========== MAIN BODY ========== */}
      <div className="flex-1 overflow-y-auto">
        
        <div className="p-3 pb-0">
          <MarketBar state={state} />
        </div>

        {/* STATS ROW */}
        <div className="flex gap-3 p-3 overflow-x-auto">
          <StatCard label="Available" value={`${fmt(balance)} USDT`} tone="neutral" />
          <StatCard label="Equity" value={`${fmt(equity)} USDT`} tone="neutral" />
          <StatCard label="Unreal. PnL" value={`${(upnl ?? 0) >= 0 ? "+" : ""}${fmt(upnl)}`} tone={pnlTone(upnl ?? 0)} />
          <StatCard label="Realized PnL" value={`${totalRealized >= 0 ? "+" : ""}${fmt(totalRealized)}`} tone={pnlTone(totalRealized)} />
          {Math.abs(phantomPnl) > 0.01 && (
            <StatCard 
              label="Phantom PnL" 
              value={`${phantomPnl >= 0 ? "+" : ""}${fmt(phantomPnl)}`} 
              tone={phantomPnl > 0 ? "warn" : "neg"} 
              tooltip="Unrecorded profits. Balance is growing but trades aren't logging to the DB."
            />
          )}
          <StatCard label="Historic PnL" value={`${totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}`} tone={pnlTone(totalPnl)} />
          <StatCard label="Win Rate" value={totalTrades > 0 ? `${(winRate * 100).toFixed(0)}%` : "—"} tone="neutral" />
          <StatCard label="Trades" value={String(totalTrades)} tone="neutral" />
        </div>

        {/* 65/35 SPLIT */}
        <div className="flex gap-0 px-3 pb-10">
          
          {/* LEFT 65% */}
          <div className="w-[65%] flex flex-col gap-3 pr-3">
            <MultiGridCard />

            <CollapsibleSection title="Charts" defaultOpen={true}>
              <div>
                <div>
                  <PriceChart state={state} />
                </div>
                <div className="border-t">
                  <EquityChart state={state} />
                </div>
              </div>
            </CollapsibleSection>
          </div>

          {/* RIGHT 35% */}
          <div className="w-[35%] flex flex-col gap-3">
            <CollapsibleSection title="Managed Exposure" defaultOpen={true}>
              <PositionCard state={state} />
            </CollapsibleSection>

            <CollapsibleSection title="ML Model" defaultOpen={true}>
              <MlCard state={state} />
            </CollapsibleSection>

            <CollapsibleSection title="Shadow ML Trainer" defaultOpen={true}>
              <ClassifierCard state={state} />
            <AdvisorCard />
            </CollapsibleSection>

            <CollapsibleSection title="Strategy Settings" defaultOpen={false}>
              <SniperCommand state={state} />
              <SettingsPanel state={state} />
            </CollapsibleSection>
          </div>
        </div>
      </div>

      {/* TERMINAL */}
      <TerminalPanel state={state} isOpen={terminalOpen} onToggle={() => setTerminalOpen(!terminalOpen)} />
      <SniperAlertBubble />
    </div>
  )
}

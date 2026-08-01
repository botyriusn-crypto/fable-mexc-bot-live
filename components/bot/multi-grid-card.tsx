"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useBotState } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"

interface GridState {
  symbol: string
  timeframe: string
  enabled: boolean
  paused: boolean
  levels: number
  effectiveLevels: number
  spacing: number | null
  buyCount: number
  sellCount: number
  unrealizedPnl: number
  realizedPnl: number
  budgetPct: number
  leverage: number
  atrMult?: number
}

const fmt = (v: number | null | undefined, d = 4) =>
  v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })

function GridRow({ grid, onRefresh }: { grid: GridState; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [levels, setLevels] = useState(grid.levels)
  const [atrMult, setAtrMult] = useState(0.5)
  const [budget, setBudget] = useState(grid.budgetPct)
  const [lev, setLev] = useState(grid.gridLeverage || grid.leverage || 2)
  const [saving, setSaving] = useState(false)
  const [orders, setOrders] = useState<Array<{side:string, price:number, quantity:number}>>([])
  const [loadingOrders, setLoadingOrders] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/bot/grid-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, levels, rangeAtrMult: atrMult, budgetPct: budget, leverage: lev }),
      })
      if (res.ok) {
        setEditing(false)
        // Force immediate refresh of the dashboard data
        setTimeout(() => onRefresh(), 300)
      }
    } catch (err) {
      console.error("Failed to save grid config:", err)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async () => {
    try {
      const newEnabled = !grid.enabled
      await fetch("/api/bot/grid-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, enabled: newEnabled }),
      })
      // If disabling, cancel all pending buys (keep sells)
      if (!newEnabled) {
        await fetch("/api/bot/grid-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, cancelBuys: true }),
        })
      }
      onRefresh()
    } catch (err) {
      console.error("Failed to toggle grid:", err)
    }
  }

  const toggleExpand = async () => {
    if (!expanded) {
      setLoadingOrders(true)
      try {
        // Fetch all pending grid orders from the API
        const res = await fetch("/api/bot/state")
        const data = await res.json()
        // The state API returns all pending orders in grid.orders
        // Filter for this specific pair
        const allOrders = data.grid?.allOrders || data.grid?.orders || []
        const pairOrders = allOrders.filter((o: any) => 
          o.symbol === grid.symbol && o.timeframe === grid.timeframe
        )
        setOrders(pairOrders.map((o: any) => ({ 
          side: o.side, 
          price: o.price, 
          quantity: o.quantity 
        })))
      } catch (err) {
        console.error("Failed to load orders:", err)
      }
      setLoadingOrders(false)
    }
    setExpanded(!expanded)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={grid.enabled ? "default" : "outline"} className="shrink-0 cursor-pointer" onClick={toggleExpand}>
            {grid.symbol}
          </Badge>
          <span className="text-muted-foreground shrink-0">{grid.timeframe}</span>
          {grid.paused && <Badge variant="outline" className="border-chart-3/40 text-chart-3 shrink-0">PAUSED</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <input type="number" value={levels} onChange={e => setLevels(Number(e.target.value))} className="w-12 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={20} title="Levels" />
              <input type="number" value={atrMult} onChange={e => setAtrMult(Number(e.target.value))} className="w-14 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={0.1} max={5} step={0.1} title="ATR Multiplier" />
              <input type="number" value={budget} onChange={e => setBudget(Number(e.target.value))} className="w-12 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={100} title="Budget %" />
              <input type="number" value={lev} onChange={e => setLev(Number(e.target.value))} className="w-10 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={10} title="Leverage" />
              <Button size="sm" variant="default" className="h-6 px-2 text-xs" onClick={handleSave} disabled={saving}>{saving ? "…" : "Save"}</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(false)}>✕</Button>
            </>
          ) : (
            <>
              <span className="font-mono text-muted-foreground">{grid.effectiveLevels}/{grid.levels}lv</span>
              <span className="font-mono text-muted-foreground">ATR {(grid as any).atrMult?.toFixed(1) || "0.5"}x</span>
              <span className="font-mono text-muted-foreground">{grid.gridLeverage || grid.leverage || 2}x</span>
              <span className="font-mono text-muted-foreground">{grid.budgetPct}%</span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={handleToggle}>{grid.enabled ? "Disable" : "Enable"}</Button>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 font-mono text-muted-foreground" onClick={toggleExpand} style={{cursor: "pointer"}}>
        <span>{grid.buyCount}B/{grid.sellCount}S</span>
        <span className={grid.unrealizedPnl >= 0 ? "text-success" : "text-danger"}>
          Unreal: {grid.unrealizedPnl >= 0 ? "+" : ""}{fmt(grid.unrealizedPnl, 2)}
        </span>
        <span className={grid.realizedPnl >= 0 ? "text-success" : "text-danger"}>
          Real: {grid.realizedPnl >= 0 ? "+" : ""}{fmt(grid.realizedPnl, 2)}
        </span>
        <span className="text-muted-foreground/50 text-[10px]">{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div className="flex flex-col gap-1 pl-2 border-l-2 border-muted">
          {loadingOrders ? (
            <span className="text-muted-foreground">Loading orders…</span>
          ) : orders.length === 0 ? (
            <span className="text-muted-foreground">No pending orders</span>
          ) : (
            orders.map((o, i) => (
              <div key={i} className="flex items-center gap-3 font-mono">
                <Badge variant="outline" className={o.side === "buy" ? "border-success/40 bg-success/10 text-success text-[10px]" : "border-danger/40 bg-danger/10 text-danger text-[10px]"}>
                  {o.side.toUpperCase()}
                </Badge>
                <span>@{o.price.toFixed(o.price < 1 ? 6 : 2)}</span>
                <span className="text-muted-foreground">×{o.quantity.toFixed(o.quantity < 1 ? 6 : 4)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function MultiGridCard() {
  const { data: state, mutate: refresh } = useBotState()
  const { mutate } = useSWRConfig()

  if (!state) return null

  const grids: GridState[] = state.gridConfigs || []
  const totalRealized = grids.reduce((s, g) => s + g.realizedPnl, 0)
  const totalUnrealized = grids.reduce((s, g) => s + g.unrealizedPnl, 0)
  const totalOrders = grids.reduce((s, g) => s + g.buyCount + g.sellCount, 0)

  const handleRefresh = async () => {
    await mutate("/api/bot/state")
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-sm font-medium">Grid Bots</CardTitle>
          <span className="text-xs text-muted-foreground">{grids.length} pairs · {totalOrders} orders active</span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className={totalRealized >= 0 ? "text-success" : "text-danger"}>Real: {totalRealized >= 0 ? "+" : ""}{fmt(totalRealized, 2)}</span>
          <span className={totalUnrealized >= 0 ? "text-success" : "text-danger"}>Unreal: {totalUnrealized >= 0 ? "+" : ""}{fmt(totalUnrealized, 2)}</span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {grids.length === 0 ? (
          <p className="text-xs text-muted-foreground">No grid configs. Run the SQL migration.</p>
        ) : (
          grids.map((grid) => (
            <GridRow key={`${grid.symbol}|${grid.timeframe}`} grid={grid} onRefresh={handleRefresh} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

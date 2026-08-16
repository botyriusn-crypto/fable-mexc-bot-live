"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBotState } from "@/lib/use-bot-state"
import { useSWRConfig } from "swr"
import useSWR from "swr"
import { ChevronsUpDown, Plus } from "lucide-react"

interface MarketOption { symbol: string; displayName: string; maxLeverage: number }

const marketsFetcher = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error("Could not load exchange markets")
  return response.json() as Promise<{ markets: MarketOption[] }>
}

function AddPairControl({ existingSymbols, onAdded }: { existingSymbols: string[]; onAdded: () => void }) {
  const { data } = useSWR("/api/bot/market", marketsFetcher, { revalidateOnFocus: false })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const filtered = useMemo(() => {
    if (!data?.markets) return []
    const q = (query || "").trim().toUpperCase()
    const pool = data.markets.filter((m) => !existingSymbols.includes(m.symbol)) // Prevents adding duplicates
    const matched = q ? pool.filter((m) => m.symbol.includes(q) || (m?.displayName || "unknown").toUpperCase().includes(q)) : pool
    return matched.slice(0, 50)
  }, [data?.markets, query, existingSymbols])

  const addPair = async (symbol: string) => {
    setAdding(true)
    setError(null)
    try {
      const res = await fetch("/api/bot/grid-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe: "Min15" }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add pair")
      setOpen(false)
      setQuery("")
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add pair")
    } finally {
      setAdding(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpen((v) => !v)}>
        <Plus className="size-3" aria-hidden="true" /> Add pair
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-card shadow-lg">
          <div className="relative border-b border-border p-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value.toUpperCase())}
              placeholder="Search coins…"
              className="h-8 pr-7 font-mono text-xs"
              autoComplete="off"
            />
            <ChevronsUpDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matching contracts</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m.symbol}
                  type="button"
                  disabled={adding}
                  onMouseDown={(e) => { e.preventDefault(); addPair(m.symbol) }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-mono text-foreground hover:bg-accent disabled:opacity-50"
                >
                  <span>{m.displayName}</span>
                  <span className="text-[10px] text-muted-foreground">{m.maxLeverage}x max</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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
  gridLeverage?: number
  atrMult?: number
  makerMode?: boolean
  direction: string
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

  const [makerBusy, setMakerBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [directionBusy, setDirectionBusy] = useState(false)
const [comboBusy, setComboBusy] = useState(false)
const isCombo = grid.direction === "neutral"
const [livePrice, setLivePrice] = useState<number | null>(null)
const [priceDir, setPriceDir] = useState<"up" | "down" | null>(null)
const prevPriceRef = useRef<number | null>(null)
useEffect(() => {
let alive = true
const load = async () => {
try {
const r = await fetch("/api/bot/live-prices")
const j = await r.json()
if (alive && j && j[grid.symbol] != null) {
const np = Number(j[grid.symbol])
const prev = prevPriceRef.current
if (prev != null && np !== prev) setPriceDir(np > prev ? "up" : "down")
prevPriceRef.current = np
setLivePrice(np)
}
} catch {}
}
load()
const t = setInterval(load, 5000)
return () => { alive = false; clearInterval(t) }
}, [grid.symbol])
const handleToggleCombo = async () => {
setComboBusy(true)
try {
await fetch("/api/bot/grid-config", {
method: "PATCH",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, direction: isCombo ? "long" : "neutral" }),
})
onRefresh()
} catch (err) {
console.error("Failed to toggle combo:", err)
} finally {
setComboBusy(false)
}
}
  
  const handleToggleDirection = async () => {
    setDirectionBusy(true)
    try {
      const currentMode = grid.direction.startsWith("auto") ? "auto" : grid.direction
      const nextDir = currentMode === "long" ? "short" : currentMode === "short" ? "auto" : "long"
      await fetch("/api/bot/grid-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, direction: nextDir }),
      })
      onRefresh()
    } catch (err) {
      console.error("Failed to toggle direction:", err)
    } finally {
      setDirectionBusy(false)
    }
  }

  const handleClearLadder = async () => {
    if (!window.confirm(`Clear all pending orders for ${grid.symbol}? This will cancel all open buy/sell orders.`)) return
    setClearing(true)
    try {
      const res = await fetch(`/api/bot/grid-ladder?symbol=${encodeURIComponent(grid.symbol)}&timeframe=${encodeURIComponent(grid.timeframe)}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to clear")
      onRefresh()
    } catch (err) {
      console.error("Failed to clear ladder:", err)
    } finally {
      setClearing(false)
    }
  }

  const handleToggleMaker = async () => {
    setMakerBusy(true)
    try {
      await fetch("/api/bot/grid-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: grid.symbol, timeframe: grid.timeframe, makerMode: !grid.makerMode }),
      })
      onRefresh()
    } catch (err) {
      console.error("Failed to toggle maker mode:", err)
    } finally {
      setMakerBusy(false)
    }
  }

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const handleDelete = async () => {
    if (!window.confirm(`Delete ${grid.symbol} (${grid.timeframe}) from the grid list? This only works if the pair is fully flat.`)) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/bot/grid-config?symbol=${encodeURIComponent(grid.symbol)}&timeframe=${encodeURIComponent(grid.timeframe)}`, {
        method: "DELETE",
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to delete")
      onRefresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  const toggleExpand = async () => {
    if (!expanded) {
      setLoadingOrders(true)
      try {
        const res = await fetch("/api/bot/state")
        const data = await res.json()
        const allOrders = data.grid?.allOrders || data.grid?.orders || []
        const pairOrders = allOrders.filter((o: any) => 
          o.symbol === grid.symbol && o.timeframe === grid.timeframe && o.status === "pending"
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Badge variant={grid.enabled ? "default" : "outline"} className="shrink-0 cursor-pointer" onClick={toggleExpand}>
            {grid.symbol}
</Badge>
{livePrice != null && <span className={`shrink-0 font-mono text-[11px] ${priceDir === "down" ? "text-danger" : priceDir === "up" ? "text-success" : "text-chart-3"}`}>@{livePrice < 1 ? livePrice.toFixed(6) : livePrice.toFixed(2)}</span>}
<label className="flex shrink-0 cursor-pointer items-center gap-1" title="COMBO: neutral two-sided grid (buys + sells placed instantly)">
<input type="checkbox" checked={isCombo} disabled={comboBusy} onChange={handleToggleCombo} className="size-3.5 accent-chart-3" />
<span className={`font-mono text-[10px] ${isCombo ? "text-chart-3" : "text-muted-foreground/60"}`}>COMBO</span>
</label>
          <span className="text-muted-foreground shrink-0">{grid.timeframe}</span>
          {grid.paused && <Badge variant="outline" className="border-chart-3/40 text-chart-3 shrink-0">PAUSED</Badge>}
          <Badge
            variant="outline"
            className={`shrink-0 cursor-pointer ${grid.makerMode ? "border-success/40 text-success" : "text-muted-foreground/60"}`}
            onClick={handleToggleMaker}
            title="Toggle maker mode (real resting orders + safety features)"
          >
            {makerBusy ? "…" : grid.makerMode ? "MAKER" : "market"}
          </Badge>
          <Badge
            variant="outline"
            className={`shrink-0 cursor-pointer ${
              grid.direction === "short" ? "border-danger/40 bg-danger/15 text-danger"
              : grid.direction === "auto" ? "border-chart-3/40 bg-chart-3/15 text-chart-3"
: grid.direction === "neutral" ? "border-chart-3/40 bg-chart-3/15 text-chart-3"
: "border-success/40 bg-success/15 text-success"
            }`}
            onClick={handleToggleDirection}
            title="Toggle direction (long/short/auto)"
          >
            {directionBusy ? "…" : 
              grid.direction === "short" ? "SHORT" 
              : grid.direction === "auto" ? "AUTO" 
              : grid.direction === "neutral" ? "NEUTRAL" : "LONG"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {editing ? (
            <>
              <input type="number" value={levels} onChange={e => setLevels(Number(e.target.value))} className="w-12 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={20} title="Levels" />
              <input type="number" value={atrMult} onChange={e => setAtrMult(Number(e.target.value))} className="w-14 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={0.1} max={5} step={0.1} title="ATR Multiplier" />
              <input type="number" value={budget} onChange={e => setBudget(Number(e.target.value))} className="w-12 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={100} title="Budget %" />
              <input type="number" value={lev} onChange={e => setLev(Number(e.target.value))} className="w-10 rounded border bg-background px-1 py-0.5 font-mono text-xs" min={1} max={10} title="Leverage" />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleClearLadder}
                disabled={clearing}
                title="Cancel all pending orders and reset the ladder"
              >
                {clearing ? "…" : "Clear"}
              </Button>
              <Button size="sm" variant="default" className="h-6 px-2 text-xs" onClick={handleSave} disabled={saving}>{saving ? "…" : "Save"}</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(false)}>✕</Button>
            </>
          ) : (
            <>
              <span className="font-mono text-muted-foreground">{grid.effectiveLevels}/{grid.levels}lv</span>
              <span className="font-mono text-muted-foreground">ATR {grid.atrMult?.toFixed(1) || "0.5"}x</span>
              <span className="font-mono text-muted-foreground">{grid.gridLeverage || grid.leverage || 2}x</span>
              <span className="font-mono text-muted-foreground">{grid.budgetPct}%</span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={handleToggle}>{grid.enabled ? "Disable" : "Enable"}</Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-danger hover:text-danger"
                onClick={handleDelete}
                disabled={deleting || grid.buyCount > 0 || grid.sellCount > 0}
                title={grid.buyCount > 0 || grid.sellCount > 0 ? "Cannot delete while orders/position are open" : "Delete this pair"}
              >
                {deleting ? "…" : "Delete"}
              </Button>
            </>
          )}
        </div>
      </div>
      {deleteError && <div className="text-danger text-[10px]">{deleteError}</div>}
      <div className="flex flex-wrap items-center gap-3 font-mono text-muted-foreground" onClick={toggleExpand} style={{cursor: "pointer"}}>
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
                  {(o?.side || "unknown").toUpperCase()}
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
const [newTf, setNewTf] = useState<string>((typeof localStorage !== "undefined" && localStorage.getItem("newGridTf")) || "Min15")
  const { data: state, mutate: refresh } = useBotState()
  const { mutate } = useSWRConfig()
  
  const [scanning, setScanning] = useState(false)
  const [aiPicks, setAiPicks] = useState<any[]>([])
  const [applyingSym, setApplyingSym] = useState<string | null>(null)

  const handleRefresh = async () => {
    await mutate("/api/bot/state")
  }

  // 3-state toggle: Idle -> Fetch & Show -> Collapse -> Fetch Fresh
  const handleScanMarket = async () => {
    // Toggle: 2nd click closes the panel, next click fetches fresh
    if (aiPicks.length > 0 && !scanning) {
      setAiPicks([]);
      return;
    }
    // State 2: If picks are currently visible, collapse the panel
    if (aiPicks.length > 0 && !scanning) {
      setAiPicks([])
      return
    }
    
    // State 1 & 3: Fetch fresh recommendations
    setScanning(true)
    setAiPicks([])
    try {
      const res = await fetch("/api/bot/ai-advisor")
      const json = await res.json()
      if (!json.success) throw new Error(json.error || "AI scan failed")
      setAiPicks(json.recommendations || [])
    } catch (err) {
      console.error("AI scan failed:", err)
      window.alert("Failed to run AI advisor. Check Fly logs.")
    } finally {
      setScanning(false)
    }
  }

  const handleApplyAIPick = async (pick: any) => {
    setApplyingSym(pick.symbol)
    try {
      const addRes = await fetch("/api/bot/grid-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: pick.symbol, timeframe: "Min15" })
      })
      if (!addRes.ok) throw new Error("Failed to add pair")

      await fetch("/api/bot/grid-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: pick.symbol,
          timeframe: "Min15",
          levels: pick.levels,
          rangeAtrMult: pick.atrMult,
          leverage: pick.leverage,
          budgetPct: pick.budgetPct,
          makerMode: true,
          direction: "neutral"
        })
      })

      await handleRefresh()
      setAiPicks(aiPicks.filter(p => p.symbol !== pick.symbol))
    } catch (err) {
      window.alert("Failed to apply settings. Check if pair already exists.")
    } finally {
      setApplyingSym(null)
    }
  }

  if (!state) return null

  const grids: GridState[] = state.gridConfigs || []
  const totalRealized = grids.reduce((s, g) => s + g.realizedPnl, 0)
  const totalUnrealized = grids.reduce((s, g) => s + g.unrealizedPnl, 0)
  const totalOrders = grids.reduce((s, g) => s + g.buyCount + g.sellCount, 0)

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-sm font-medium">Grid Bots</CardTitle>
        <div className="flex items-center gap-2 ml-auto mr-4">
          <Button 
            onClick={async () => {
              const res = await fetch("/api/bot/sync-orders", { method: "POST" })
              const data = await res.json().catch(() => ({}))
              if (data.success) {
                alert(`✅ Synced: ${data.imported} imported, ${data.reactivated} reactivated`)
                setTimeout(() => window.location.reload(), 500)
              } else {
                alert("❌ Sync failed: " + (data.error || "unknown"))
              }
            }} 
            size="sm" 
            variant="outline" 
            className="text-xs h-7 px-3 transition-all hover:bg-success/10 hover:border-success/40"
            title="Import all open orders from MEXC"
          >
            🔗 Sync Live Orders
          </Button>
          <Button 
            onClick={async () => {
              if (!window.confirm(`Cancel ALL live orders for ALL ${grids.length} pairs on MEXC (including orphans)?`)) return
              let totalMexc = 0
              let totalDb = 0
              const failures: string[] = []
              for (const g of grids) {
                try {
                  const res = await fetch("/api/bot/clear-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: g.symbol }) })
                  const data = await res.json().catch(() => ({}))
                  if (data.success) {
                    totalMexc += data.cancelledOnMexc || 0
                    totalDb += data.cancelledInDb || 0
                  } else {
                    failures.push(g.symbol)
                  }
                } catch {
                  failures.push(g.symbol)
                }
                await new Promise(r => setTimeout(r, 250))
              }
              alert(failures.length === 0
                ? `✅ Cancelled ${totalMexc} on MEXC, ${totalDb} in DB across ${grids.length} pairs`
                : `⚠️ Cancelled ${totalMexc} on MEXC, ${totalDb} in DB. Failed for: ${failures.join(", ")}`)
              setTimeout(() => window.location.reload(), 500)
            }} 
            size="sm" 
            variant="outline" 
            className="text-xs h-7 px-3 transition-all hover:bg-danger/10 hover:border-danger/40"
            title="Cancel ALL orders for ALL pairs on MEXC, including orphans"
          >
            🧹 Cancel MEXC Orders
          </Button>
          <Button 
            onClick={async () => {
              const res = await fetch("/api/bot/rotate", { method: "POST" })
              const data = await res.json().catch(() => ({}))
              if (data.success) {
                alert("✅ Rotation complete! Check Activity Log.")
                setTimeout(() => window.location.reload(), 500)
              } else {
                alert("❌ Rotation failed: " + (data.error || "unknown"))
              }
            }} 
            size="sm" 
            variant="outline" 
            className="text-xs h-7 px-3 transition-all hover:bg-chart-3/10 hover:border-chart-3/40"
            title="Manually trigger portfolio rotation now"
          >
            🔄 Rotate Now
          </Button>
          <Button 
            onClick={async () => {
              const currentState = state.rotationEnabled
              await fetch("/api/bot/rotate", { 
                method: "POST", 
                headers: {"Content-Type":"application/json"}, 
                body: JSON.stringify({enabled: !currentState}) 
              })
              alert(currentState ? "❌ Auto-rotation disabled!" : "✅ Auto-rotation enabled! Runs every 4 hours.")
              setTimeout(() => window.location.reload(), 500)
            }} 
            size="sm" 
            variant="outline" 
            className={`text-xs h-7 px-3 transition-all ${
              state.rotationEnabled 
                ? 'bg-success/20 border-success/60 text-success font-bold shadow-[0_0_8px_rgba(var(--success),0.3)]' 
                : 'hover:bg-danger/10 hover:border-danger/40'
            }`}
            title={state.rotationEnabled ? 'Auto-rotation is ON (click to disable)' : 'Auto-rotation is OFF (click to enable)'}
          >
            ⏰ {state.rotationEnabled ? 'Auto ON' : 'Auto OFF'}
          </Button>
        </div>
          <span className="text-xs text-muted-foreground">{grids.length} pairs · {totalOrders} orders active</span>
        {state.lastRotationTime && state.lastRotationTime > 0 && (
          <span className="text-xs text-muted-foreground">
            · Last rotation: {new Date(state.lastRotationTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
          </span>
        )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs font-mono">
          <span className={totalRealized >= 0 ? "text-success" : "text-danger"}>Real: {totalRealized >= 0 ? "+" : ""}{fmt(totalRealized, 2)}</span>
          <span className={totalUnrealized >= 0 ? "text-success" : "text-danger"}>Unreal: {totalUnrealized >= 0 ? "+" : ""}{fmt(totalUnrealized, 2)}</span>
          <AddPairControl existingSymbols={grids.map((g) => g.symbol)} onAdded={handleRefresh} />
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-chart-3/50 bg-chart-3/15 text-chart-3 hover:bg-chart-3/25"
            onClick={handleScanMarket}
            disabled={scanning}
            title="AI scans MEXC and configures the optimal grid settings"
          >
            {scanning ? "🤖 AI Analyzing..." : aiPicks.length > 0 ? "✕ Close AI Picks" : scanning ? "🤖 AI Analyzing..." : aiPicks.length > 0 ? "✕ Close AI Picks" : "🤖 AI Advisor"}
          </Button>
<select value={newTf} onChange={(e) => { setNewTf(e.target.value); localStorage.setItem("newGridTf", e.target.value) }} className="h-7 shrink-0 rounded-md border border-border bg-background px-1 font-mono text-[11px] text-muted-foreground" title="Timeframe for NEW grids">
<option value="Min15">15m</option>
<option value="Min60">1h</option>
<option value="Hour4">4h</option>
</select>
        <div className="flex items-center gap-1 mr-2" title="Available budget to deploy">
          {(() => {
            const totalDeployed = grids.reduce((s, g) => s + (g.budgetPct || 0), 0)
            const avail = Math.max(0, Math.round(100 - totalDeployed))
            const color = avail >= 40 ? "text-success border-success/40 bg-success/10" : avail >= 20 ? "text-chart-3 border-chart-3/40 bg-chart-3/10" : "text-danger border-danger/40 bg-danger/10"
            return <span className={`shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded border ${color}`}>💰 {avail}% free</span>
          })()}
        </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {aiPicks.length > 0 && (
          <div className="flex flex-col gap-2 p-2 border border-chart-3/30 rounded-md bg-chart-3/5">
            <span className="text-xs font-bold text-chart-3">AI Recommendations:</span>
            {aiPicks.map((pick) => (
              <div key={pick.symbol} className="flex flex-col gap-1 p-2 bg-background/50 rounded border border-border">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-sm">{pick.symbol}</span>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-6 px-2 py-0 bg-success text-success-foreground hover:bg-success/80"
                    disabled={applyingSym === pick.symbol}
                    onClick={() => handleApplyAIPick(pick)}
                  >
                    {applyingSym === pick.symbol ? "Building..." : "Apply & Build"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{pick.reason}</p>
                <div className="flex gap-2 text-xs text-muted-foreground mt-1">
                  <span>Lvls: {pick.levels}</span>
                  <span>ATR: {pick.atrMult}x</span>
                  <span>Lev: {pick.leverage}x</span>
                  <span>Budg: {pick.budgetPct}%</span>
                </div>
              </div>
            ))}
          </div>
        )}
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

"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useBotState } from "@/lib/use-bot-state"

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
}

const fmt = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })

function analyzeGrid(grid: GridState): { status: "healthy" | "warning" | "issue"; message: string; action: string } {
  const totalOrders = grid.buyCount + grid.sellCount
  
  // No activity at all
  if (totalOrders === 0 && grid.enabled && !grid.paused) {
    return {
      status: "warning",
      message: "No orders placed yet",
      action: "Market may be trending. Grid will deploy when ranging conditions return."
    }
  }

  // Paused by trend detection
  if (grid.paused) {
    return {
      status: "warning", 
      message: "Auto-paused (trending market)",
      action: "No action needed — will auto-resume when ADX drops."
    }
  }

  // Disabled
  if (!grid.enabled) {
    return { status: "issue", message: "Disabled", action: "Enable to start trading this pair." }
  }

  // Only sells, no buys — price below the ladder
  if (grid.buyCount === 0 && grid.sellCount > 0) {
    return {
      status: "issue",
      message: `Price below all buy levels (${grid.sellCount} sells waiting)`,
      action: "Consider widening ATR multiplier or increasing levels to place buys lower."
    }
  }

  // Only buys, no sells — price above the ladder
  if (grid.buyCount > 0 && grid.sellCount === 0) {
    return {
      status: "warning",
      message: `All sells filled, ${grid.buyCount} buys waiting for dip`,
      action: "Grid is reloading. Wait for price to reach buy levels."
    }
  }

  // Balanced — buys and sells active
  if (grid.buyCount > 0 && grid.sellCount > 0) {
    const ratio = grid.sellCount / (grid.buyCount + grid.sellCount)
    if (ratio > 0.7) {
      return {
        status: "warning",
        message: "Inventory-heavy — more sells than buys",
        action: "Price may be above ladder midpoint. Reduce leverage or take profit on sells."
      }
    }
    return {
      status: "healthy",
      message: `Balanced: ${grid.buyCount} buys, ${grid.sellCount} sells`,
      action: "Grid cycling normally. No adjustments needed."
    }
  }

  // Making money
  if (grid.realizedPnl > 5) {
    return {
      status: "healthy",
      message: `Profitable: +${fmt(grid.realizedPnl)} USDT realized`,
      action: "Consider increasing budget % to scale up this winning pair."
    }
  }

  // Losing money
  if (grid.realizedPnl < -5) {
    return {
      status: "issue",
      message: `Losing: ${fmt(grid.realizedPnl)} USDT realized`,
      action: "Check if spacing is below fee floor. May need to disable or widen ATR."
    }
  }

  return { status: "healthy", message: "Grid active", action: "No action needed." }
}

export function PerformanceAnalyzer() {
  const { data: state } = useBotState()
  if (!state) return null

  const grids: GridState[] = state.gridConfigs || []
  const activeGrids = grids.filter(g => g.enabled)
  const totalRealized = grids.reduce((s, g) => s + g.realizedPnl, 0)
  const totalUnrealized = grids.reduce((s, g) => s + g.unrealizedPnl, 0)

  const statusColors = {
    healthy: "border-success/40 bg-success/10 text-success",
    warning: "border-chart-3/40 bg-chart-3/10 text-chart-3",
    issue: "border-danger/40 bg-danger/10 text-danger",
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Performance Analyzer</CardTitle>
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className={totalRealized >= 0 ? "text-success" : "text-danger"}>
              P&L: {totalRealized >= 0 ? "+" : ""}{fmt(totalRealized)} USDT
            </span>
            <span className="text-muted-foreground">
              {activeGrids.length} active
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {grids.length === 0 ? (
          <p className="text-xs text-muted-foreground">No grid pairs configured.</p>
        ) : (
          grids.map((grid) => {
            const analysis = analyzeGrid(grid)
            return (
              <div key={`${grid.symbol}|${grid.timeframe}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">{grid.symbol}</Badge>
                    <Badge variant="outline" className={`text-[10px] ${statusColors[analysis.status]}`}>
                      {analysis.status.toUpperCase()}
                    </Badge>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {grid.buyCount}B/{grid.sellCount}S · Real: {grid.realizedPnl >= 0 ? "+" : ""}{fmt(grid.realizedPnl)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground pl-1 border-l-2 border-muted">
                  {analysis.message}
                </p>
                <p className="text-[11px] text-muted-foreground/70 pl-1">
                  💡 {analysis.action}
                </p>
              </div>
            )
          })
        )}
        {totalUnrealized !== 0 && (
          <div className="border-t pt-2 text-xs text-muted-foreground">
            Total unrealized: <span className={totalUnrealized >= 0 ? "text-success font-mono" : "text-danger font-mono"}>
              {totalUnrealized >= 0 ? "+" : ""}{fmt(totalUnrealized)}
            </span> USDT
          </div>
        )}
      </CardContent>
    </Card>
  )
}

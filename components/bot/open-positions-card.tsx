"use client"
import { Card, CardContent } from "@/components/ui/card"

export function OpenPositionsCard({ state }: { state: any }) {
  const breakdown = state?.strategyBreakdown || { grid: { unrealized: 0, count: 0 }, sniper: { unrealized: 0, count: 0 }, swing: { unrealized: 0, count: 0 }, trend: { unrealized: 0, count: 0 } }
  const total = Object.values(breakdown).reduce((s: number, b: any) => s + (b.unrealized || 0), 0)
  const totalOpen = Object.values(breakdown).reduce((s: number, b: any) => s + (b.count || 0), 0)
  
  const fmt = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`
  const tone = (v: number) => v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground"
  
  return (
    <Card className="border-blue-400/30 bg-blue-900/10">
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-xs text-blue-200/60 uppercase tracking-wide">Total Unrealized PnL</div>
            <div className={`text-4xl font-bold ${tone(total)}`}>{fmt(total)}</div>
          </div>
          <div className="text-sm text-blue-200/70">{totalOpen} open position{totalOpen !== 1 ? 's' : ''}</div>
        </div>
        
        <div className="grid grid-cols-4 gap-2">
          {(['grid', 'trend', 'swing', 'sniper'] as const).map(strat => (
            <div key={strat} className="rounded-lg border border-blue-400/20 bg-blue-950/30 p-2">
              <div className="text-xs text-blue-200/60 capitalize mb-1">{strat}</div>
              <div className={`text-lg font-semibold ${tone(breakdown[strat]?.unrealized || 0)}`}>
                {fmt(breakdown[strat]?.unrealized || 0)}
              </div>
              <div className="text-xs text-blue-200/50 mt-0.5">
                {breakdown[strat]?.count || 0} open
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

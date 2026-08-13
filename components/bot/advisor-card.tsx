"use client"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const fetcher = (u: string) => fetch(u).then(r => r.json())

export function AdvisorCard() {
  const { data } = useSWR("/api/bot/advisor", fetcher, { refreshInterval: 60000 })
  const variants: any[] = data?.variants ?? []
  return (
    <Card className="border-yellow-400/40 bg-yellow-400/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-bold text-yellow-300">🧬 Super Advisor — Self-Learning Sniper Params</CardTitle>
        <p className="text-xs text-yellow-200/70">Five strategies compete on every resolved shadow decision. Zero capital at risk. The leader will auto-tune the sniper gate once proven.</p>
      </CardHeader>
      <CardContent className="space-y-1">
        {variants.length === 0 && <div className="text-xs text-yellow-200/60">Waiting for shadow resolutions…</div>}
        {variants.map((v, i) => (
          <div key={v.name} className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-xs ${i === 0 ? "border-yellow-400/60 bg-yellow-400/10 text-yellow-200" : "border-muted/40 text-muted-foreground"}`}>
            <span className="font-mono">{i === 0 ? "👑 " : "   "}{v.name}</span>
            <span className="font-mono">{v.stats.allowed} tries · {v.stats.allowed > 0 ? Math.round((v.stats.correct / Math.max(v.stats.allowed, 1)) * 100) : 0}% win · score {Number(v.score).toFixed(2)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

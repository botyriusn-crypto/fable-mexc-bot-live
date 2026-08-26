"use client"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const fetcher = (u: string) => fetch(u).then(r => r.json())

export function AdvisorCard() {
  const { data } = useSWR("/api/bot/advisor", fetcher, { refreshInterval: 60000 })
  const variants: any[] = data?.variants ?? []
  const tested = variants.filter((v: any) => (v.stats?.allowed ?? 0) >= 10)
  const hottest = tested.length > 0 ? tested.reduce((a: any, b: any) => (b.stats.correct / b.stats.allowed > a.stats.correct / a.stats.allowed ? b : a)) : null
  return (
    <Card className="border-yellow-400/40 bg-yellow-400/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-bold text-yellow-300">🧬 Super Advisor — Self-Learning Sniper Params</CardTitle>
        <p className="text-xs text-yellow-200/70">Five strategies compete on every resolved sniper decision. Zero capital at risk. The leader will auto-tune the sniper gate once proven.</p>
      </CardHeader>
      <CardContent className="space-y-1">
        {variants.length === 0 && <div className="text-xs text-yellow-200/60">Waiting for sniper resolutions…</div>}
        {variants.map((v, i) => (
          <div key={v.name} className={`rounded-md border px-2 py-1.5 text-xs ${i === 0 ? "border-yellow-400/60 bg-yellow-400/10 text-yellow-200" : "border-muted/40 text-muted-foreground"}`}>
            <div className="flex items-center justify-between">
              <span className="font-mono">{i === 0 ? "👑 " : "   "}{v.name}</span>
              <span className="font-mono">{v.stats.allowed} tries · {v.stats.allowed > 0 ? Math.round((v.stats.correct / Math.max(v.stats.allowed, 1)) * 100) : 0}% win · LCB {Number(v.score).toFixed(2)}</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] opacity-70">
              minConf {v.params?.minConf ?? "—"} · volSurge ×{v.params?.volSurgeMult ?? "—"} · σ {v.params?.sigmaExtreme ?? "—"}
            </div>
          </div>
        ))}
        {hottest && (
          <div className="mt-1 rounded-md border border-yellow-400/30 bg-yellow-400/5 p-2 text-[10px] text-yellow-200/70">
            📈 Hottest raw win rate: <span className="font-mono text-yellow-200">{hottest.name}</span> ({Math.round((hottest.stats.correct / hottest.stats.allowed) * 100)}% over {hottest.stats.allowed} tries)
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-yellow-200/60">
          LCB = 95% lower confidence bound of win rate. Ranks proven performance, not volume — 64% over 25 tries now outranks 50% over 165.
        </p>
      </CardContent>
    </Card>
  )
}

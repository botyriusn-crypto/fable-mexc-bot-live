import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const PARAM_LABELS: Record<string, string> = {
  sweepLookback: "Sweep lookback",
  volumeSurgeMult: "Volume surge ×",
  sigmaExtreme: "Sigma extreme",
  fundingThreshold: "Funding threshold",
  tpSlRatio: "TP:SL ratio",
  resolveAfterBuckets: "Resolve after",
}

export function ClassifierCard({ state }: { state: any }) {
  const s = (state as any)?.sniperStats
  const total = s?.totalEvaluations ?? 0
  const resolved = s?.resolvedCount ?? 0
  const correct = s?.correctCount ?? 0
  const accuracy = s?.accuracy ?? 0
  const params: Record<string, number> = s?.params ?? {}

  return (
    <Card className="border-yellow-400/50 bg-yellow-400/5 shadow-[0_0_16px_rgba(250,204,21,0.12)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-bold text-yellow-300">Sniper Signal — Rule-Based Entry</CardTitle>
        <p className="text-xs text-yellow-200/70">
          Liquidity sweeps + sigma exhaustion. No ML weights — the advisor tunes the rule params directly.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3 text-center">
            <div className="text-3xl font-bold text-yellow-300">{total}</div>
            <div className="text-[10px] text-yellow-200/70">SIGNALS</div>
          </div>
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3 text-center">
            <div className="text-3xl font-bold text-yellow-300">{resolved}</div>
            <div className="text-[10px] text-yellow-200/70">RESOLVED</div>
          </div>
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3 text-center">
            <div className="text-3xl font-bold text-yellow-300">{resolved > 0 ? (accuracy * 100).toFixed(0) + "%" : "—"}</div>
            <div className="text-[10px] text-yellow-200/70">ACCURACY ({correct}/{resolved})</div>
          </div>
        </div>

        {s?.bySignalType && (
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3">
            <div className="text-[10px] text-yellow-200/70 mb-1">ACCURACY BY SIGNAL TYPE</div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>SWEEP</span>
              <span>{s.bySignalType.sweep.count > 0 ? `${(s.bySignalType.sweep.accuracy * 100).toFixed(0)}% (${s.bySignalType.sweep.correct}/${s.bySignalType.sweep.count})` : "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>SIGMA</span>
              <span>{s.bySignalType.sigma.count > 0 ? `${(s.bySignalType.sigma.accuracy * 100).toFixed(0)}% (${s.bySignalType.sigma.correct}/${s.bySignalType.sigma.count})` : "—"}</span>
            </div>
            <div className="text-[10px] text-yellow-200/70 mt-2 mb-1">SIDE SPLITS</div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span className="text-success">LONG</span>
              <span>{s.byDirection.long.count > 0 ? `${(s.byDirection.long.accuracy * 100).toFixed(0)}% (${s.byDirection.long.correct}/${s.byDirection.long.count})` : "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span className="text-danger">SHORT</span>
              <span>{s.byDirection.short.count > 0 ? `${(s.byDirection.short.accuracy * 100).toFixed(0)}% (${s.byDirection.short.correct}/${s.byDirection.short.count})` : "—"}</span>
            </div>
          </div>
        )}

        {s?.confidenceBuckets && (
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3">
            <div className="text-[10px] text-yellow-200/70 mb-1">ACCURACY BY CONFIDENCE BUCKET</div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>HIGH ≥70%</span>
              <span>{s.confidenceBuckets.high.count > 0 ? `${(s.confidenceBuckets.high.accuracy * 100).toFixed(0)}% (${s.confidenceBuckets.high.correct}/${s.confidenceBuckets.high.count})` : "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>MID 55–70%</span>
              <span>{s.confidenceBuckets.mid.count > 0 ? `${(s.confidenceBuckets.mid.accuracy * 100).toFixed(0)}% (${s.confidenceBuckets.mid.correct}/${s.confidenceBuckets.mid.count})` : "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>LOW &lt;55%</span>
              <span>{s.confidenceBuckets.low.count > 0 ? `${(s.confidenceBuckets.low.accuracy * 100).toFixed(0)}% (${s.confidenceBuckets.low.correct}/${s.confidenceBuckets.low.count})` : "—"}</span>
            </div>
            <div className="text-[10px] text-yellow-200/70 mt-2 mb-1">REGIME DECAY CHECK</div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>LAST 50 RESOLVED</span>
              <span>{s.rollingAccuracy.last50 > 0 ? `${(s.rollingAccuracy.last50 * 100).toFixed(0)}%` : "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono text-yellow-200/80">
              <span>ALL-TIME</span>
              <span>{(s.rollingAccuracy.allTime * 100).toFixed(0)}%</span>
            </div>
          </div>
        )}

        <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3">
          <div className="text-[10px] text-yellow-200/70 mb-2">RULE PARAMETERS (advisor-tuned)</div>
          <div className="space-y-1">
            {Object.entries(PARAM_LABELS).map(([k, label]) => {
              const v = params[k]
              return (
                <div key={k} className="flex items-center justify-between text-[10px]">
                  <span className="text-yellow-200/70">{label}</span>
                  <span className="font-mono text-yellow-200/80">{v !== undefined ? v : "—"}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className={`rounded-md border p-2 text-[10px] ${(state as any)?.watchdog?.issues?.length ? "border-danger/50 bg-danger/10 text-danger" : "border-yellow-400/30 bg-yellow-400/10 text-yellow-200/70"}`}>
          🛡️ Watchdog: {(state as any)?.watchdog?.issues?.length ? (state as any).watchdog.issues.join(" · ") : "all clear"}
          {((state as any)?.watchdog?.fixed?.length ?? 0) > 0 && <span className="text-success"> · auto-fixed: {(state as any).watchdog.fixed.join(", ")}</span>}
          {(state as any)?.watchdog?.lastRun ? <span className="opacity-60"> · checked {new Date((state as any).watchdog.lastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
        </div>

        <p className="text-[10px] leading-relaxed text-yellow-200/60">
          {resolved < 100
            ? `Collecting baseline… ${100 - resolved} more resolved signals before the sniper is trusted to gate live entries.`
            : accuracy >= 0.55
              ? "Sniper shows a real edge — ready to be wired as a live entry gate."
              : "Sniper not beating baseline yet — keep collecting, do not gate entries."}
        </p>
      </CardContent>
    </Card>
  )
}

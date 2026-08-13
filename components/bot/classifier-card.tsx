import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function ClassifierCard({ state }: { state: any }) {
  const s = (state as any)?.shadowStats
  const total = s?.totalEvaluations ?? 0
  const resolved = s?.resolvedCount ?? 0
  const correct = s?.correctCount ?? 0
  const accuracy = s?.accuracy ?? 0
  const top = s?.topCandidate

  return (
    <Card className="border-yellow-400/50 bg-yellow-400/5 shadow-[0_0_16px_rgba(250,204,21,0.12)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-bold text-yellow-300">
          Shadow ML — Live Entry Training
        </CardTitle>
        <p className="text-xs text-yellow-200/70">
          Scores every pair on every candle without placing orders, then grades itself against real price movement.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3 text-center">
            <div className="text-3xl font-bold text-yellow-300">{total}</div>
            <div className="text-[10px] text-yellow-200/70">EVALUATIONS</div>
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

        {top && (
          <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3">
            <div className="text-[10px] text-yellow-200/70 mb-1">STRONGEST CURRENT READ</div>
            <div className="font-mono text-xl font-bold text-yellow-300">
              {top.symbol}{" "}
              <span className={top.direction === "long" ? "text-success" : "text-danger"}>
                {String(top.direction).toUpperCase()}
              </span>{" "}
              <span className="text-yellow-200/80">({(((top.confidence ?? 0) as number) * 100).toFixed(0)}%)</span>
            </div>
          </div>
        )}

                <div className={`rounded-md border p-2 text-[10px] ${(state as any)?.watchdog?.issues?.length ? "border-danger/50 bg-danger/10 text-danger" : "border-yellow-400/30 bg-yellow-400/10 text-yellow-200/70"}`}>
          🛡️ Watchdog: {(state as any)?.watchdog?.issues?.length ? (state as any).watchdog.issues.join(" · ") : "all clear"}
          {((state as any)?.watchdog?.fixed?.length ?? 0) > 0 && <span className="text-success"> · auto-fixed: {(state as any).watchdog.fixed.join(", ")}</span>}
          {(state as any)?.watchdog?.lastRun ? <span className="opacity-60"> · checked {new Date((state as any).watchdog.lastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
        </div>
        <p className="text-[10px] leading-relaxed text-yellow-200/60">
          {resolved < 100
            ? `Collecting baseline… ${100 - resolved} more resolved decisions before this model is trusted to gate SNIPER entries.`
            : accuracy >= 0.55
              ? "Model shows a real edge — ready to be wired as a SNIPER entry gate."
              : "Model not beating baseline yet — keep collecting, do not gate entries."}
        </p>
      </CardContent>
    </Card>
  )
}

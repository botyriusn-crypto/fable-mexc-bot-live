"use client"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const fetcher = (u: string) => fetch(u).then((r) => r.json())

export function AdvancedStrategyCard() {
  const { data } = useSWR("/api/bot/advanced-strategy", fetcher, { refreshInterval: 30000 })
  const sig = data?.signal ?? null
  const cfg = data?.config ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>🎯 Advanced Signal Strategy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!cfg ? (
          <p className="text-muted-foreground">Waiting for advanced strategy state…</p>
        ) : !cfg.enabled ? (
          <p className="text-muted-foreground">
            Advanced strategy is <span className="font-semibold">disabled</span>. Enable it in settings.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span>Status</span>
              <span className={sig?.passed ? "text-green-500 font-semibold" : "text-red-500 font-semibold"}>
                {sig?.passed ? "PASSED" : sig ? "BLOCKED" : "idle"}
              </span>
            </div>

            {sig?.mtf && (
              <div className="flex items-center justify-between">
                <span>Multi-timeframe</span>
                <span className={sig.mtf.aligned ? "text-green-500" : "text-red-500"}>
                  {Math.round(sig.mtf.alignment * 100)}% aligned
                </span>
              </div>
            )}

            {sig?.smartMoney && (
              <div className="flex items-center justify-between">
                <span>Smart money</span>
                <span className={sig.smartMoney.confirmed ? "text-green-500" : "text-red-500"}>
                  {sig.smartMoney.score.toFixed(2)}
                </span>
              </div>
            )}

            {sig?.sizeUsdt != null && (
              <div className="flex items-center justify-between">
                <span>Suggested size</span>
                <span className="font-semibold">${sig.sizeUsdt.toFixed(0)} USDT</span>
              </div>
            )}

            {sig?.reason && <p className="text-muted-foreground text-xs">{sig.reason}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

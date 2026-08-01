import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { BotState } from "@/lib/use-bot-state"

const percent = (value: number | null) => value == null ? "Collecting" : `${Math.round(value * 100)}%`

export function ClassifierCard({ state }: { state: BotState }) {
  const analytics = state.classifierAnalytics
  const latest = analytics.latest

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-sm font-medium">Entry confirmation</CardTitle>
          <span className="text-xs text-muted-foreground">Four-closed-bar comparison</span>
        </div>
        <Badge variant="outline" className="uppercase">{state.config.confirmationMode}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Logistic" value={percent(analytics.logisticAccuracy)} />
          <Metric label="Lorentzian" value={percent(analytics.lorentzianAccuracy)} />
          <Metric label="Agreement" value={percent(analytics.agreementRate)} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-xs">
          <span className="text-muted-foreground">Candidates</span>
          <span className="font-mono">
            {analytics.sampleCount} total · {analytics.acceptedCount} accepted · {analytics.rejectedCount} rejected
          </span>
        </div>
        {latest ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">Latest {latest.candidateDirection} candidate</span>
              <span className="font-mono">vote {latest.lorentzianVote > 0 ? "+" : ""}{latest.lorentzianVote}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <span>Logistic <strong className="font-mono">{Math.round(latest.logisticConfidence * 100)}%</strong></span>
              <span>Lorentzian <strong className="font-mono">{Math.round(latest.lorentzianConfidence * 100)}%</strong></span>
            </div>
            <p className="text-pretty text-xs leading-relaxed text-muted-foreground">{latest.reason}</p>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Waiting for the next Trend/Range entry candidate. Observe mode is safe for collecting a baseline.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="font-mono text-sm">{value}</strong>
    </div>
  )
}

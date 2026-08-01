"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Line,
  LineChart,
  Area,
  AreaChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import type { BotState } from "@/lib/use-bot-state"

function formatTime(t: number) {
  const d = new Date(t * 1000)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

export function PriceChart({ state }: { state: BotState }) {
  const data = state.chart.map((c) => ({ ...c, label: formatTime(c.time) }))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {state.config.symbol} · {state.config.timeframe} · EMA {state.config.emaFast}/{state.config.emaSlow}
        </CardTitle>
      </CardHeader>
      <CardContent className="h-64">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Market data unavailable
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" minTickGap={40} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 10 }}
                stroke="var(--color-muted-foreground)"
                width={70}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--color-muted-foreground)" }}
              />
              <Line type="monotone" dataKey="close" stroke="var(--color-foreground)" dot={false} strokeWidth={1.5} name="Price" />
              <Line type="monotone" dataKey="emaFast" stroke="var(--color-chart-1)" dot={false} strokeWidth={1} name={`EMA ${state.config.emaFast}`} />
              <Line type="monotone" dataKey="emaSlow" stroke="var(--color-chart-2)" dot={false} strokeWidth={1} name={`EMA ${state.config.emaSlow}`} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

export function EquityChart({ state }: { state: BotState }) {
  const data = state.equityCurve.map((e) => ({
    equity: e.equity,
    label: new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Equity Curve</CardTitle>
      </CardHeader>
      <CardContent className="h-64">
        {data.length < 2 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Waiting for equity snapshots — start the bot to begin recording
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" minTickGap={40} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 10 }}
                stroke="var(--color-muted-foreground)"
                width={70}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--color-muted-foreground)" }}
              />
              <Area
                type="monotone"
                dataKey="equity"
                stroke="var(--color-chart-1)"
                fill="url(#equityFill)"
                strokeWidth={1.5}
                name="Equity"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

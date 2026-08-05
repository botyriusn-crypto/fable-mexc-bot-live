"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { BotState } from "@/lib/use-bot-state"

function formatLocalTime(dateStr: string): string {
  const d = new Date(dateStr)
  // Force Eastern timezone explicitly
  return d.toLocaleTimeString("en-US", { 
    hour: "2-digit", 
    minute: "2-digit", 
    second: "2-digit",
    hour12: true,
    timeZone: "America/New_York"
  })
}

export function ActivityLog({ state }: { state: BotState }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Activity Log</CardTitle>
          <button
            onClick={async () => {
              if (confirm("Clear all activity logs?")) {
                await fetch("/api/bot/clear-logs", { method: "DELETE" })
                window.location.reload()
              }
            }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border hover:bg-muted transition-colors"
          >
            Clear
          </button>
      </CardHeader>
      <CardContent>
        {state.logs.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            No activity yet
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-xs">
            {state.logs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                <span className="shrink-0 text-muted-foreground" suppressHydrationWarning>
                  {formatLocalTime(log.createdAt as string)}
                </span>
                <span
                  className={
                    log.level === "error"
                      ? "text-danger"
                      : log.level === "trade"
                        ? "text-success"
                        : "text-foreground"
                  }
                >
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

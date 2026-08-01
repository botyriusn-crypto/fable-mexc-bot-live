"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { BotState } from "@/lib/use-bot-state"

const REASON_LABELS: Record<string, string> = {
  tp: "TP",
  sl: "SL",
  trail: "TRAIL",
  signal: "SIGNAL",
  manual: "MANUAL",
}

export function TradesTable({ state }: { state: BotState }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Trade History</CardTitle>
      </CardHeader>
      <CardContent>
        {state.trades.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            No closed trades yet
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Side</TableHead>
                <TableHead className="text-xs">Strategy</TableHead>
                <TableHead className="text-xs">Entry</TableHead>
                <TableHead className="text-xs">Exit</TableHead>
                <TableHead className="text-right text-xs">PnL (USDT)</TableHead>
                <TableHead className="text-right text-xs">Conf.</TableHead>
                <TableHead className="text-right text-xs">Exit via</TableHead>
                <TableHead className="text-right text-xs">Closed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <span className={`font-mono text-xs font-semibold ${t.side === "long" ? "text-success" : "text-danger"}`}>
                      {t.side.toUpperCase()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {(t as unknown as { strategy?: string }).strategy ?? "trend"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.entryPrice.toFixed(2)}</TableCell>
                  <TableCell className="font-mono text-xs">{t.exitPrice.toFixed(2)}</TableCell>
                  <TableCell className={`text-right font-mono text-xs ${t.pnl >= 0 ? "text-success" : "text-danger"}`}>
                    {t.pnl >= 0 ? "+" : ""}
                    {t.pnl.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {t.entryConfidence != null ? `${(t.entryConfidence * 100).toFixed(0)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className="text-[10px]">
                      {REASON_LABELS[t.exitReason] ?? t.exitReason}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {t.closedAt ? new Date(t.closedAt as unknown as string).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

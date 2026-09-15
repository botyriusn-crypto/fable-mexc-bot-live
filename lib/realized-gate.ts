// Realized-performance gate — shared by the grid advisor's candidate filter
// and the scalp advisor-tap feed. Backtest validation is a one-time admission
// ticket that never expires, so a validated pair can bleed live indefinitely
// and still score 100 on every scan. This gate reads trailing realized PnL
// from the books (DB-backed, restart-proof) with a thin-history pass: too few
// closes to judge is not a proven loser.
import { db } from "./db"
import { botConfig, trades } from "./db/schema"
import { eq, and, gte, sql } from "drizzle-orm"

export const REALIZED_WINDOW_DAYS = 14
export const REALIZED_MIN_TRADES = 3

export interface RealizedSymbolStats {
  netPnl: number
  closedTrades: number
}

export function isRealizedLoser(netPnl: number, closedTrades: number): boolean {
  if (!Number.isFinite(netPnl) || !Number.isFinite(closedTrades)) return false
  return closedTrades >= REALIZED_MIN_TRADES && netPnl <= 0
}

/**
 * Trailing-window realized PnL per symbol, filtered BY MODE (live and paper
 * books never mix). Symbols with no closes in the window are absent (thin
 * history passes). Fail-open on DB error with a loud log line.
 */
export async function getRealizedStats(): Promise<Map<string, RealizedSymbolStats>> {
  const empty = new Map<string, RealizedSymbolStats>()
  try {
    const cfgRows = await db
      .select({ mode: botConfig.mode })
      .from(botConfig)
      .where(eq(botConfig.id, 1))
    const modeIsLive = cfgRows[0]?.mode === "live"
    const cutoff = new Date(Date.now() - REALIZED_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const rows = await db
      .select({
        symbol: trades.symbol,
        net: sql<number | string | null>`sum(${trades.pnl})`,
        n: sql<number | string | null>`count(*)`,
      })
      .from(trades)
      .where(and(eq(trades.live, modeIsLive), gte(trades.closedAt, cutoff)))
      .groupBy(trades.symbol)
    const stats = new Map<string, RealizedSymbolStats>()
    for (const r of rows) {
      const net = Number(r.net)
      const n = Number(r.n)
      if (!r.symbol || !Number.isFinite(n) || n <= 0) continue
      stats.set(r.symbol, { netPnl: Number.isFinite(net) ? net : 0, closedTrades: n })
    }
    return stats
  } catch (err) {
    console.error(`[RealizedGate] stats query failed (fail-open): ${err instanceof Error ? err.message : String(err)}`)
    return empty
  }
}

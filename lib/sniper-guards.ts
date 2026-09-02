// lib/sniper-guards.ts
// Entry guards for the sniper engine. Everything here is a REFUSAL rule —
// nothing changes how a signal is generated, only whether a generated signal
// is allowed to become a live position.
//
// Evidence (30-trade sample, Aug 25 – Sep 2, 5/30 wins, every loss = -1R):
//   * SPX_USDT: 3 long entries in 4 min (07:41:30, 07:45:14, 07:45:15), all lost.
//     :14/:15 = two ticks racing (multi-machine Fly); 07:41 -> 07:45 = re-entry
//     into the same failing setup after a -1R stop.
//   * Universe is ranked by |24h move|, so longs buy "dips" on the day's
//     biggest pumpers — the source of the "buys the top" complaint.
import { db } from "./db"
import { positions, trades } from "./db/schema"
import { and, eq, gte, sql } from "drizzle-orm"

function envNum(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : def
}

// All tunable via env (same pattern as risk-manager.ts / exposure.ts).
export const SNIPER_GUARDS = {
  // After a losing sniper trade on a symbol: no new sniper entry on it for N min.
  lossCooldownMin: () => envNum("SNIPER_LOSS_COOLDOWN_MIN", 240),
  // Never re-enter a symbol within N min of the last sniper entry (open OR closed).
  // Also the backstop for the concurrent-tick race.
  reentryWindowMin: () => envNum("SNIPER_REENTRY_WINDOW_MIN", 30),
  // Max losing sniper trades per symbol per rolling 24h.
  maxSymbolLossesPerDay: () => envNum("SNIPER_MAX_SYMBOL_LOSSES_DAY", 1),
  // Max sniper entries (all symbols) per rolling 24h.
  maxEntriesPerDay: () => envNum("SNIPER_MAX_ENTRIES_DAY", 6),
  // Stop sniping once rolling-24h realised sniper PnL <= -N * sniperTargetRiskUsdt.
  maxDailyLossR: () => envNum("SNIPER_MAX_DAILY_LOSS_R", 3),
  // Skip coins already UP more than this fraction over 24h (0.25 = +25%).
  // MEXC riseFallRate is a fraction — verify: grep -n riseFallRate lib/mexc/public.ts
  maxPump24h: () => envNum("SNIPER_MAX_24H_PUMP", 0.25),
  // Refuse the fill if live price is more than this fraction above the signal close.
  maxEntrySlip: () => envNum("SNIPER_MAX_ENTRY_SLIP", 0.004),
}

export interface GuardResult {
  allowed: boolean
  reason?: string
}

// Decide whether a sniper LONG on `symbol` may be opened right now.
// Cheap checks first, DB checks after. Returns the first failing rule.
export async function sniperEntryGuard(
  symbol: string,
  rise24h: number | undefined,
  targetRiskUsdt: number,
): Promise<GuardResult> {
  const G = SNIPER_GUARDS
  const now = Date.now()
  const since24h = new Date(now - 24 * 3600_000)

  // 1. Pump filter: don't buy the dip on today's top gainer.
  if (rise24h != null && rise24h > G.maxPump24h()) {
    return { allowed: false, reason: `pump_filter_24h_+${(rise24h * 100).toFixed(0)}pct` }
  }

  // 2. Any open position on this symbol, any strategy → no stacking.
  const open = await db
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.symbol, symbol), eq(positions.status, "open")))
    .limit(1)
  if (open.length > 0) return { allowed: false, reason: "symbol_already_open" }

  // 3. Re-entry window: any sniper position on this symbol opened recently.
  const recent = await db
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.symbol, symbol),
        eq(positions.strategy, "sniper"),
        gte(positions.openedAt, new Date(now - G.reentryWindowMin() * 60_000)),
      ),
    )
    .limit(1)
  if (recent.length > 0) return { allowed: false, reason: "reentry_window" }

  // 4. Loss cooldown on this symbol.
  const recentLoss = await db
    .select({ id: trades.id })
    .from(trades)
    .where(
      and(
        eq(trades.symbol, symbol),
        eq(trades.strategy, "sniper"),
        sql`${trades.pnl} < 0`,
        gte(trades.closedAt, new Date(now - G.lossCooldownMin() * 60_000)),
      ),
    )
    .limit(1)
  if (recentLoss.length > 0) return { allowed: false, reason: "loss_cooldown" }

  // 5. Per-symbol daily loss count.
  const [symLoss] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trades)
    .where(
      and(
        eq(trades.symbol, symbol),
        eq(trades.strategy, "sniper"),
        sql`${trades.pnl} < 0`,
        gte(trades.closedAt, since24h),
      ),
    )
  if ((symLoss?.n ?? 0) >= G.maxSymbolLossesPerDay()) {
    return { allowed: false, reason: "symbol_daily_loss_cap" }
  }

  // 6. Global daily entry cap.
  const [entries] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(positions)
    .where(and(eq(positions.strategy, "sniper"), gte(positions.openedAt, since24h)))
  if ((entries?.n ?? 0) >= G.maxEntriesPerDay()) {
    return { allowed: false, reason: "daily_entry_cap" }
  }

  // 7. Global daily loss cap in R.
  if (targetRiskUsdt > 0) {
    const [pnl] = await db
      .select({ s: sql<number>`coalesce(sum(${trades.pnl}), 0)::float` })
      .from(trades)
      .where(and(eq(trades.strategy, "sniper"), gte(trades.closedAt, since24h)))
    if ((pnl?.s ?? 0) <= -G.maxDailyLossR() * targetRiskUsdt) {
      return { allowed: false, reason: "daily_loss_r_cap" }
    }
  }

  return { allowed: true }
}

// Serialise guard+open on one symbol across ALL processes sharing the DB.
// pg_advisory_xact_lock is released automatically at transaction end. The
// callback runs its own queries on the pool (autocommit) while the lock is
// held on the tx connection, so a second machine hitting the same symbol
// waits, then re-runs the guard and sees the position the first one opened.
export async function withSniperLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"sniper:" + symbol}))`)
    return fn()
  })
}

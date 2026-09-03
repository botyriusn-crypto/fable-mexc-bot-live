import { getExchangeClient } from "./exchange"
// Portfolio-level risk layer.
//
// Purpose: protect a SMALL account (<$500) from the two ways it usually dies —
//   (1) a single bad day spiraling into revenge-sized losses, and
//   (2) slow peak-to-trough bleed while "learning".
//
// Design: every tick the engine calls `evaluatePortfolioRisk(cfg)`, which reads
// authoritative numbers from the DB (realized PnL from `trades`, equity history
// from `equitySnapshots`, committed margin from open positions + pending grid
// orders), decides whether new risk may be taken, and caches the result.
//
// Every order-OPENING path (openPosition, setupGrid) then calls the cheap
// synchronous `isTradingHalted()` / `canOpenNewPosition()` before committing new
// capital. EXITS, stop-losses and teardowns are NEVER blocked — the layer only
// prevents ADDING risk, never removing it.

import { db } from "./db"
import { trades, positions, gridOrders, equitySnapshots, type BotConfig } from "./db/schema"
import { unrealizedPnl } from "./engine"
import { and, eq, gte, lt, desc, sql } from "drizzle-orm"

// ── Configurable limits ─────────────────────────────────────────────────────
// All fractions (0.08 = 8%). Overridable via env so they can be tuned without
// a redeploy. Defaults are deliberately conservative for a sub-$500 account.
function envNum(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : def
}

export const RISK_LIMITS = {
  // Halt NEW trades once the day is down this much vs. the day-start equity.
  // Auto-resets at the next UTC day rollover (baseline rolls forward).
  maxDailyLossPct: () => envNum("MAX_DAILY_LOSS_PCT", 0.08),
  // Hard kill switch: equity this far below the rolling 7-day peak stops ALL
  // new risk until equity recovers above the threshold.
  maxDrawdownPct: () => envNum("MAX_DRAWDOWN_PCT", 0.2),
  // Cap total committed margin (trend positions + pending grid budget) at this
  // fraction of equity, so the account can never be fully deployed at once.
  maxTotalMarginPct: () => envNum("MAX_TOTAL_MARGIN_PCT", 0.6),
  // Max concurrent TREND positions (grid orders are budgeted separately).
  maxOpenPositions: () => Math.max(1, Math.round(envNum("MAX_OPEN_POSITIONS", 4))),
}

export interface RiskState {
  tradingHalted: boolean // any halt reason active → block new entries & new grid orders
  killSwitch: boolean // severe (drawdown) halt
  reasons: string[]
  equity: number
  dayStartEquity: number
  peakEquity: number
  dailyRealizedPnl: number
  dailyPnl: number // realized + unrealized vs day start
  dailyPnlPct: number
  drawdownPct: number
  usedMargin: number
  usedMarginPct: number
  marginBudgetRemaining: number // USDT of margin still allowed under the cap
  openPositionCount: number
  updatedAt: number
}

let _state: RiskState | null = null

export function getRiskState(): RiskState | null {
  return _state
}
export function isTradingHalted(): boolean {
  return _state?.tradingHalted ?? false
}
export function isKillSwitchActive(): boolean {
  return _state?.killSwitch ?? false
}
/** True if another trend position can be opened (count + not halted). */
export function canOpenNewPosition(): boolean {
  if (!_state) return true
  if (_state.tradingHalted) return false
  return _state.openPositionCount < RISK_LIMITS.maxOpenPositions()
}
/** USDT of additional margin permitted right now under the total-margin cap. */
export function marginBudgetRemaining(): number {
  return _state?.marginBudgetRemaining ?? Number.POSITIVE_INFINITY
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
}

/**
 * Recompute the portfolio risk state and cache it. Call once near the start of
 * each tick (and optionally again at the end after the fresh equity snapshot).
 *
 * `liveUnrealized` (optional) lets the caller pass the freshly-computed total
 * unrealized PnL; when omitted we fall back to the last equity snapshot's value.
 */
export async function evaluatePortfolioRisk(cfg: BotConfig, liveUnrealized?: number): Promise<RiskState> {
  const now = new Date()
  const dayStart = utcDayStart(now)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // ── Realized PnL today (authoritative, from closed trades) ──
  const [dailyRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${trades.pnl}), 0)` })
    .from(trades)
    .where(gte(trades.closedAt, dayStart))
  const dailyRealizedPnl = Number(dailyRow?.total ?? 0)

  // ── Unrealized PnL (from caller, else compute from live positions) ──
  let unrealized = liveUnrealized
  if (unrealized == null) {
    // Compute from live positions + live mark prices (matching dashboard logic)
    const openPositions = await db.select().from(positions).where(eq(positions.status, "open"))
    const symbols = [...new Set(openPositions.map(p => p.symbol))]
    
    // Fetch mark prices for all open position symbols
    const marks = new Map<string, number>()
    for (const symbol of symbols) {
      try {
        const ticker = await getExchangeClient(cfg.exchange).fetchTicker(symbol)
        if (ticker?.lastPrice != null) marks.set(symbol, Number(ticker.lastPrice))
      } catch { /* best-effort */ }
    }
    
    // Sum unrealized across all open positions
    unrealized = openPositions.reduce((sum, pos) => {
      const mark = marks.get(pos.symbol)
      if (mark == null) return sum
      return sum + unrealizedPnl(pos, mark)
    }, 0)
  }

  const balance = Number(cfg.paperBalance ?? 0)
  const equity = balance + unrealized

  // ── Day-start equity baseline (last snapshot before UTC midnight) ──
  const [prevSnap] = await db
    .select()
    .from(equitySnapshots)
    .where(lt(equitySnapshots.createdAt, dayStart))
    .orderBy(desc(equitySnapshots.createdAt))
    .limit(1)
  let dayStartEquity = prevSnap ? Number(prevSnap.equity) : NaN
  if (!Number.isFinite(dayStartEquity)) {
    // No history before today → use the earliest snapshot from today.
    const [firstToday] = await db
      .select()
      .from(equitySnapshots)
      .where(gte(equitySnapshots.createdAt, dayStart))
      .orderBy(equitySnapshots.createdAt)
      .limit(1)
    dayStartEquity = firstToday ? Number(firstToday.equity) : equity
  }
  if (!Number.isFinite(dayStartEquity) || dayStartEquity <= 0) dayStartEquity = equity || 1

  // ── Rolling 7-day peak equity (for drawdown kill switch) ──
  const [peakRow] = await db
    .select({ peak: sql<number>`COALESCE(MAX(${equitySnapshots.equity}), 0)` })
    .from(equitySnapshots)
    .where(gte(equitySnapshots.createdAt, sevenDaysAgo))
  let peakEquity = Number(peakRow?.peak ?? 0)
  peakEquity = Math.max(peakEquity, equity, dayStartEquity)
  if (peakEquity <= 0) peakEquity = equity || 1

  // ── Committed margin (trend positions + pending grid budget) ──
  const openPositions = await db.select().from(positions).where(eq(positions.status, "open"))
  const trendMargin = openPositions.reduce((s, p) => s + Number(p.sizeUsdt ?? 0), 0)

  const pendingGrid = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
  const gridMargin = pendingGrid.reduce((s, o) => {
    const lev = Number(o.leverage ?? 1) || 1
    return s + (Number(o.price ?? 0) * Number(o.quantity ?? 0)) / lev
  }, 0)

  const usedMargin = trendMargin + gridMargin
  const usedMarginPct = equity > 0 ? usedMargin / equity : 1
  const marginCap = RISK_LIMITS.maxTotalMarginPct() * equity
  const marginBudgetRemaining = Math.max(0, marginCap - usedMargin)

  // ── Derived metrics ──
  const dailyPnl = equity - dayStartEquity
  const dailyPnlPct = dayStartEquity > 0 ? dailyPnl / dayStartEquity : 0
  const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0

  // ── Decide halts ──
  const reasons: string[] = []
  let killSwitch = false

  if (drawdownPct >= RISK_LIMITS.maxDrawdownPct()) {
    killSwitch = true
    reasons.push(
      `KILL SWITCH: drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ ${(RISK_LIMITS.maxDrawdownPct() * 100).toFixed(0)}% from 7d peak (${peakEquity.toFixed(2)})`,
    )
  }
  if (dailyPnlPct <= -RISK_LIMITS.maxDailyLossPct()) {
    reasons.push(
      `Daily loss limit: ${(dailyPnlPct * 100).toFixed(1)}% ≤ -${(RISK_LIMITS.maxDailyLossPct() * 100).toFixed(0)}% (halts until next UTC day)`,
    )
  }
  if (usedMarginPct >= RISK_LIMITS.maxTotalMarginPct()) {
    reasons.push(
      `Margin cap: ${(usedMarginPct * 100).toFixed(0)}% of equity committed ≥ ${(RISK_LIMITS.maxTotalMarginPct() * 100).toFixed(0)}%`,
    )
  }

  const tradingHalted = reasons.length > 0

  _state = {
    tradingHalted,
    killSwitch,
    reasons,
    equity,
    dayStartEquity,
    peakEquity,
    dailyRealizedPnl,
    dailyPnl,
    dailyPnlPct,
    drawdownPct,
    usedMargin,
    usedMarginPct,
    marginBudgetRemaining,
    openPositionCount: openPositions.length,
    updatedAt: Date.now(),
  }
  return _state
}

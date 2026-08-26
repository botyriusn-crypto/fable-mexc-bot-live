// lib/grid-flow.ts
// Adaptive flow-gate + per-symbol kill-switch ("be like water").
//
// Validated policy (backtest_maxhold.py, 2026-08):
//   - 6h rolling-PnL flow gate: block NEW grid entries when the symbol's
//     trailing 6h realized PnL is negative.
//   - Adaptive kill-switch: every 24h, measure whether the gate is helping.
//     Gate ON  -> sum the counterfactual (shadow) PnL of entries it blocked;
//                 if those would have been net-positive, the gate is costing
//                 money, so disable it and run ungated.
//     Gate OFF -> measure the real (ungated) PnL; if it is losing, re-enable
//                 the gate to try to stop the bleed.
//   Re-evaluated each window so it can flip back — the gate adapts to whether
//   it is helping or hurting each symbol.
//
// State is persisted to Postgres (grid_flow_state / grid_flow_shadow) so the
// kill-switch survives restarts. This module never mutates gridConfigs or
// trades, so the portfolio rotator and AI Advisor (which read those tables)
// remain fully compatible.

import { db } from "./db"
import { trades, gridFlowState, gridFlowShadow } from "./db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { log } from "./logger"

export const FLOW_GATE_WINDOW_MS = 6 * 60 * 60 * 1000    // 6h rolling PnL
export const KILL_SWITCH_WINDOW_MS = 24 * 60 * 60 * 1000  // 24h meta window

// ── Rolling PnL ──
// Sum of realized grid PnL (strategy === "grid") closed within the window.
export async function rollingGridPnl(symbol: string, windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs)
  const rows = await db
    .select({ pnl: trades.pnl })
    .from(trades)
    .where(and(eq(trades.symbol, symbol), eq(trades.strategy, "grid"), gte(trades.closedAt, since)))
  return rows.reduce((sum, r) => sum + Number(r.pnl), 0)
}

// ── Persisted flow state ──
async function getFlowState(symbol: string): Promise<{ gateEnabled: boolean; lastEvalAt: number }> {
  const rows = await db.select().from(gridFlowState).where(eq(gridFlowState.symbol, symbol)).limit(1)
  if (rows.length === 0) {
    await db.insert(gridFlowState).values({ symbol, gateEnabled: true }).onConflictDoNothing()
    return { gateEnabled: true, lastEvalAt: 0 }
  }
  const r = rows[0]
  return { gateEnabled: r.gateEnabled, lastEvalAt: r.lastEvalAt ? new Date(r.lastEvalAt).getTime() : 0 }
}

// ── Entry gate ──
// True if new entries should be BLOCKED for this symbol right now.
export async function shouldGateEntry(symbol: string): Promise<boolean> {
  const st = await getFlowState(symbol)
  if (!st.gateEnabled) return false // kill-switch disabled the gate
  return (await rollingGridPnl(symbol, FLOW_GATE_WINDOW_MS)) < 0
}

// ── Shadow (counterfactual) tracking ──
export interface ShadowEntry {
  symbol: string
  side: "long" | "short"
  entryPrice: number
  quantity: number
  leverage: number
  tpPrice: number
  slPrice: number
}

export async function recordShadowEntry(e: ShadowEntry): Promise<void> {
  await db.insert(gridFlowShadow).values({
    symbol: e.symbol, side: e.side, entryPrice: e.entryPrice,
    quantity: e.quantity, leverage: e.leverage,
    tpPrice: e.tpPrice, slPrice: e.slPrice, status: "open",
  })
}

// Resolve open shadow positions against the current price. A shadow long
// "fills" its TP if price >= tpPrice, or its SL if price <= slPrice (mirror
// of the real grid's fill logic). The realized counterfactual PnL is folded
// into the shadow ledger for the kill-switch. quantity is normalized (1), so
// the magnitude is arbitrary — only the SIGN drives the kill-switch decision.
export async function resolveShadowEntries(symbol: string, price: number): Promise<void> {
  const open = await db.select().from(gridFlowShadow).where(
    and(eq(gridFlowShadow.symbol, symbol), eq(gridFlowShadow.status, "open"))
  )
  for (const s of open) {
    let resolvedPnl: number | null = null
    if (s.side === "long") {
      if (s.tpPrice != null && price >= s.tpPrice) resolvedPnl = (s.tpPrice - s.entryPrice) * s.quantity
      else if (s.slPrice != null && price <= s.slPrice) resolvedPnl = (s.slPrice - s.entryPrice) * s.quantity
    } else {
      if (s.tpPrice != null && price <= s.tpPrice) resolvedPnl = (s.entryPrice - s.tpPrice) * s.quantity
      else if (s.slPrice != null && price >= s.slPrice) resolvedPnl = (s.entryPrice - s.slPrice) * s.quantity
    }
    if (resolvedPnl !== null) {
      await db.update(gridFlowShadow)
        .set({ status: "resolved", resolvedPnl, resolvedAt: sql`NOW()` })
        .where(eq(gridFlowShadow.id, s.id))
    }
  }
}

// ── Kill-switch evaluation ──
// Every KILL_SWITCH_WINDOW_MS, decide whether the gate is helping. Self-
// throttles via lastEvalAt so it is safe to call on every tick.
export async function evaluateKillSwitch(symbol: string): Promise<void> {
  const st = await getFlowState(symbol)
  const now = Date.now()
  if (now - st.lastEvalAt < KILL_SWITCH_WINDOW_MS) return // not due yet

  const since = new Date(now - KILL_SWITCH_WINDOW_MS)
  let newGate = st.gateEnabled

  if (st.gateEnabled) {
    // Gate ON: measure the shadow (blocked) PnL. If blocked entries would
    // have been net-positive, the gate is costing money → disable it.
    const resolved = await db
      .select({ pnl: gridFlowShadow.resolvedPnl })
      .from(gridFlowShadow)
      .where(and(
        eq(gridFlowShadow.symbol, symbol),
        eq(gridFlowShadow.status, "resolved"),
        gte(gridFlowShadow.resolvedAt, since),
      ))
    const shadowPnl = resolved.reduce((sum, r) => sum + Number(r.pnl ?? 0), 0)
    if (shadowPnl > 0) newGate = false
  } else {
    // Gate OFF: measure the real (ungated) PnL. If it is losing, the gate
    // might help → re-enable it.
    const pnl = await rollingGridPnl(symbol, KILL_SWITCH_WINDOW_MS)
    if (pnl < 0) newGate = true
  }

  await db.update(gridFlowState)
    .set({ gateEnabled: newGate, lastEvalAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(eq(gridFlowState.symbol, symbol))

  if (newGate !== st.gateEnabled) {
    await log("info", `Flow-gate ${symbol}: kill-switch ${newGate ? "RE-ENABLED" : "DISABLED"} gate`)
  }
}

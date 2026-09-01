// lib/exposure.ts
// Cross-strategy exposure aggregation.
//
// The entry engines (trend, scalp, sniper, trend-rider, funding-carry, webhook)
// each size their own position off their own risk rule, and grid deploys its
// own ladder. Nothing stops three of them from going long the same symbol at
// once, so the portfolio's real directional exposure to a single coin can be
// 3x what any one engine's risk check assumes.
//
// This module answers one question — "what is our net exposure to symbol X,
// across everything, right now?" — and gates new entries against per-symbol
// caps so correlated blowups can't silently stack.

import { db } from "./db"
import { positions, gridOrders } from "./db/schema"
import { and, eq, isNotNull } from "drizzle-orm"

// Per-symbol caps, as a fraction of equity. Overridable via env so they can
// be tuned without a redeploy (same pattern as risk-manager.ts).
function envNum(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : def
}

export const EXPOSURE_LIMITS = {
  // Net directional notional (long - short) per symbol, as a fraction of equity.
  maxNetNotionalPctOfEquity: () => envNum("MAX_NET_EXPOSURE_PCT", 0.15),
  // Gross notional (long + short) per symbol — allows some hedged overlap.
  maxGrossNotionalPctOfEquity: () => envNum("MAX_GROSS_EXPOSURE_PCT", 0.25),
}

export interface SymbolExposure {
  symbol: string
  net: number // long - short notional
  long: number
  short: number
  gross: number // long + short
  byStrategy: Record<string, number> // signed net notional per strategy
}

// Sum notional exposure to `symbol` across trend/scalp/sniper/rider positions
// AND grid held inventory.
//
// Notional conventions (important — they differ by table):
//   positions.sizeUsdt is MARGIN (unleveraged), so notional = sizeUsdt * leverage.
//   gridOrders.quantity already encodes leveraged notional
//     (notionalPerLevel = budget/orderCount * leverage, quantity = notional/price),
//     so grid notional = price * quantity.
export async function getSymbolExposure(symbol: string): Promise<SymbolExposure> {
  const open = await db
    .select()
    .from(positions)
    .where(and(eq(positions.symbol, symbol), eq(positions.status, "open")))

  let net = 0
  let long = 0
  let short = 0
  const byStrategy: Record<string, number> = {}

  for (const p of open) {
    const notional = Number(p.sizeUsdt ?? 0) * Number(p.leverage ?? 1)
    const signed = p.side === "long" ? notional : -notional
    net += signed
    if (p.side === "long") long += notional
    else short += notional
    const strat = p.strategy ?? "trend"
    byStrategy[strat] = (byStrategy[strat] ?? 0) + signed
  }

  // Grid held inventory only: a pending sell with buyPrice set is a filled buy
  // awaiting its sell (LONG); a pending buy with buyPrice set is a filled short
  // awaiting buy-to-close (SHORT). Naked resting orders (buyPrice null) are
  // unfilled and carry no exposure yet.
  const gridHeld = await db
    .select()
    .from(gridOrders)
    .where(and(eq(gridOrders.symbol, symbol), eq(gridOrders.status, "pending"), isNotNull(gridOrders.buyPrice)))

  let gridNet = 0
  let gridLong = 0
  let gridShort = 0
  for (const o of gridHeld) {
    const notional = Number(o.buyPrice ?? 0) * Number(o.quantity ?? 0)
    if (o.side === "sell") {
      gridLong += notional
      gridNet += notional
    } else {
      gridShort += notional
      gridNet -= notional
    }
  }
  byStrategy["grid"] = gridNet
  net += gridNet
  long += gridLong
  short += gridShort

  return { symbol, net, long, short, gross: long + short, byStrategy }
}

// Gate a proposed entry against the per-symbol caps. Returns whether the entry
// is allowed and, if not, which cap it would breach.
export async function checkExposureGate(
  symbol: string,
  direction: "long" | "short",
  proposedNotional: number,
  equity: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const exp = await getSymbolExposure(symbol)
  const projectedNet = exp.net + (direction === "long" ? proposedNotional : -proposedNotional)
  const projectedGross = exp.gross + proposedNotional
  const eq = equity > 0 ? equity : 1

  if (Math.abs(projectedNet) / eq > EXPOSURE_LIMITS.maxNetNotionalPctOfEquity()) {
    return { allowed: false, reason: "net_exposure_cap" }
  }
  if (projectedGross / eq > EXPOSURE_LIMITS.maxGrossNotionalPctOfEquity()) {
    return { allowed: false, reason: "gross_exposure_cap" }
  }
  return { allowed: true }
}

// Grid-specific gate: a grid deploys a full ladder of notional (budget ×
// leverage) at once, and a neutral/COMBO grid is two-sided (its net direction
// is ~0, so only the gross cap applies). Directional grids additionally check
// the net cap. Reuses the same per-symbol limits as checkExposureGate.
export async function checkGridExposureGate(
  symbol: string,
  direction: "long" | "short" | "neutral",
  proposedNotional: number,
  equity: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const exp = await getSymbolExposure(symbol)
  const eq = equity > 0 ? equity : 1
  const projectedGross = exp.gross + proposedNotional
  if (projectedGross / eq > EXPOSURE_LIMITS.maxGrossNotionalPctOfEquity()) {
    return { allowed: false, reason: "gross_exposure_cap" }
  }
  if (direction !== "neutral") {
    const projectedNet = exp.net + (direction === "long" ? proposedNotional : -proposedNotional)
    if (Math.abs(projectedNet) / eq > EXPOSURE_LIMITS.maxNetNotionalPctOfEquity()) {
      return { allowed: false, reason: "net_exposure_cap" }
    }
  }
  return { allowed: true }
}

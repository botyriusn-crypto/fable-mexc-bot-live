import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, trades, gridOrders } from "@/lib/db/schema"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { livePrices } from "@/lib/mexc/ws"

export const dynamic = "force-dynamic"

// Baseline equity this endpoint rescues FROM. Was a bare hardcoded constant,
// which silently drifts the moment the account is topped up or withdrawn.
// Env-overridable so the value lives with the deployment, not in code.
const INITIAL_EQUITY = Number(process.env.RESCUE_INITIAL_EQUITY ?? 10104.0)

export async function GET() {
  try {
    // 1. Realized PnL, net of fees, from closed trades. This is the single
    //    source of realized cash movement, so it is added exactly once here.
    const tradeStats = await db.select({
      totalPnl: sql`COALESCE(SUM(${trades.pnl}), 0)`
    }).from(trades)

    const realizedPnl = Number(tradeStats[0]?.totalPnl || 0)
    const trueEquity = INITIAL_EQUITY + realizedPnl

    // 2. Unrealized PnL from OPEN grid inventory.
    //
    //    In this codebase a held grid position is a still-PENDING order with a
    //    non-null buyPrice (the ACTUAL entry): a pending SELL is a held LONG
    //    awaiting its TP, and a pending BUY is a held SHORT awaiting its
    //    buy-to-close. See gridUnrealizedPnl() in lib/grid.ts and
    //    reconcileOrphanedPositions() for the same convention.
    //
    //    The previous version of this endpoint selected status='filled' (i.e.
    //    rows that have ALREADY been settled and are therefore already inside
    //    trades.pnl — double counting), used o.price (the order's target price,
    //    not the entry) and had long/short inverted.
    const heldOrders = await db
      .select()
      .from(gridOrders)
      .where(and(eq(gridOrders.status, "pending"), isNotNull(gridOrders.buyPrice)))

    let unrealizedPnl = 0

    for (const o of heldOrders) {
      const currentPrice = livePrices[o.symbol]
      const entryPrice = o.buyPrice
      if (!currentPrice || currentPrice <= 0 || !entryPrice || !o.quantity) continue

      if (o.side === "sell") {
        // Held LONG: profit if price rises above entry.
        unrealizedPnl += (currentPrice - entryPrice) * o.quantity
      } else if (o.side === "buy") {
        // Held SHORT: profit if price falls below entry.
        unrealizedPnl += (entryPrice - currentPrice) * o.quantity
      }
    }

    // 3. Persist the rescued equity. paperBalance tracks settled cash only, so
    //    unrealized is reported but not folded in (unchanged from before).
    await db.update(botConfig).set({
      paperBalance: trueEquity,
      updatedAt: new Date()
    }).where(eq(botConfig.id, 1))

    return NextResponse.json({
      success: true,
      initial: INITIAL_EQUITY,
      realizedPnl: realizedPnl.toFixed(2),
      unrealizedPnl: unrealizedPnl.toFixed(2),
      heldOrders: heldOrders.length,
      rescuedEquity: trueEquity.toFixed(2),
      message: "Equity rescued! Margin deductions disabled."
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}

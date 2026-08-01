import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const rows = await db.select().from(gridConfigs).orderBy(gridConfigs.symbol)
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe, ...updates } = body
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }
    
    const allowed = ["levels", "rangeAtrMult", "budgetPct", "leverage", "feeMarginMult", "autoPause", "enabled"]
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(updates)) {
      if (allowed.includes(key)) filtered[key] = updates[key]
    }
    
    // Handle cancelBuys action
    if (body.cancelBuys) {
      await db.update(gridOrders)
        .set({ status: "cancelled" })
        .where(and(eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe), eq(gridOrders.side, "buy"), eq(gridOrders.status, "pending")))
      return NextResponse.json({ ok: true, message: "Buys cancelled, sells kept" })
    }

    if (Object.keys(filtered).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
    }

    await db.update(gridConfigs)
      .set(filtered)
      .where(and(eq(gridConfigs.symbol, symbol), eq(gridConfigs.timeframe, timeframe)))

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

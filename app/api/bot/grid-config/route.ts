import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, and, inArray } from "drizzle-orm"
import { cancelOrders } from "@/lib/mexc/private"
import { log } from "@/lib/grid"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const rows = await db.select().from(gridConfigs).orderBy(gridConfigs.symbol)
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe } = body
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }
    const existing = await db.select().from(gridConfigs)
      .where(and(eq(gridConfigs.symbol, symbol.toUpperCase()), eq(gridConfigs.timeframe, timeframe)))
      .limit(1)
    if (existing.length > 0) {
      return NextResponse.json({ error: "This pair already exists" }, { status: 409 })
    }
    await db.insert(gridConfigs).values({
      symbol: symbol.toUpperCase(),
      timeframe,
      enabled: false,
      levels: 5,
      rangeAtrMult: 0.5,
      budgetPct: 5,
      leverage: 3,
      feeMarginMult: 3,
      autoPause: true,
      makerMode: !!body.makerMode,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const symbol = searchParams.get("symbol")
    const timeframe = searchParams.get("timeframe")
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }

    const pending = await db.select().from(gridOrders)
      .where(and(eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe), eq(gridOrders.status, "pending")))
    if (pending.length > 0) {
      return NextResponse.json({
        error: `Cannot delete: ${pending.length} pending order(s)/position still open. Disable the pair and wait for them to close first.`,
      }, { status: 409 })
    }

    await db.delete(gridConfigs)
      .where(and(eq(gridConfigs.symbol, symbol), eq(gridConfigs.timeframe, timeframe)))
    return NextResponse.json({ ok: true })
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
    
    const allowed = ["levels", "rangeAtrMult", "budgetPct", "leverage", "feeMarginMult", "autoPause", "enabled", "makerMode"]
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(updates)) {
      if (allowed.includes(key)) filtered[key] = updates[key]
    }
    
    // Handle cancelBuys action
    if (body.cancelBuys) {
      const pendingBuys = await db.select().from(gridOrders)
        .where(and(eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe), eq(gridOrders.side, "buy"), eq(gridOrders.status, "pending")))

      // Real resting maker orders need to be cancelled ON THE EXCHANGE first,
      // or disabling just orphans them — they'd keep resting live on MEXC
      // with nothing in our DB tracking or managing them anymore.
      const realOrderIds = pendingBuys.filter((o) => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
      if (realOrderIds.length > 0) {
        try {
          await cancelOrders(realOrderIds)
          await log("info", `Grid ${symbol}: disabled — cancelled ${realOrderIds.length} real resting buy(s) on exchange`)
        } catch (err) {
          await log("error", `Grid ${symbol}: disable requested but failed cancelling real resting buys on exchange: ${err instanceof Error ? err.message : String(err)}`)
          return NextResponse.json({ error: "Failed to cancel real resting orders on exchange — grid NOT disabled, orders still live. Try again." }, { status: 500 })
        }
      }

      if (pendingBuys.length > 0) {
        await db.update(gridOrders)
          .set({ status: "cancelled", exchangeStatus: realOrderIds.length > 0 ? "cancelled" : undefined })
          .where(inArray(gridOrders.id, pendingBuys.map((o) => o.id)))
      }
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

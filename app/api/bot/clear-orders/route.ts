import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders } from "@/lib/db/schema"
import { and, eq, inArray } from "drizzle-orm"
import { fetchOpenOrders, cancelOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const { symbol } = await req.json()
    if (!symbol) return NextResponse.json({ success: false, error: "symbol required" }, { status: 400 })

    // 1. Ask MEXC what's actually open and cancel it all (batches of 10)
    let cancelledOnMexc = 0
    const open = await fetchOpenOrders(symbol)
    const ids = open.map((o: any) => String(o.orderId))
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10)
      try {
        await cancelOrders(batch)
        cancelledOnMexc += batch.length
      } catch (e) {
        console.error(`[Clear] batch cancel failed for ${symbol}:`, String(e))
      }
      await new Promise(r => setTimeout(r, 200))
    }

    // 2. Mark all tracked rows (pending + external) as cancelled in DB
    const updated = await db.update(gridOrders)
      .set({ status: "cancelled", exchangeStatus: "cancelled" })
      .where(and(eq(gridOrders.symbol, symbol), inArray(gridOrders.status, ["pending", "external"])))
      .returning({ id: gridOrders.id })

    console.log(`[Clear] ${symbol}: cancelled ${cancelledOnMexc} on MEXC, ${updated.length} in DB`)

    return NextResponse.json({ success: true, cancelledOnMexc, cancelledInDb: updated.length })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders, gridConfigs } from "@/lib/db/schema"
import { sql, eq, inArray } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const enabledConfigs = await db.select({ symbol: gridConfigs.symbol }).from(gridConfigs)
    const historicalSymbols = await db.select({ symbol: gridOrders.symbol }).from(gridOrders).groupBy(gridOrders.symbol)
    const allSymbols = [...new Set([...enabledConfigs.map(c => c.symbol), ...historicalSymbols.map(s => s.symbol)])]

    let imported = 0, reactivated = 0, skipped = 0
    const perSymbol: any[] = []

    for (const symbol of allSymbols) {
      try {
        const mexcOrders = await fetchOpenOrders(symbol)
        let si = 0, sr = 0

        for (const order of mexcOrders) {
          const orderId = String(order.orderId)
          const side = order.side === 1 ? "buy" : "sell"
          const existing = await db.select().from(gridOrders).where(sql`${gridOrders.mexcOrderId} = ${orderId}`)

          if (existing.length === 0) {
            await db.execute(sql`INSERT INTO grid_orders (symbol, timeframe, side, price, quantity, status, mexc_order_id, exchange_status, created_at, synced_at)
              VALUES (${symbol}, 'Min15', ${side}, ${Number(order.price)}, ${Number(order.volume)}, 'external', ${orderId}, 'open', NOW(), NOW())`)
            imported++; si++
          } else if (existing[0].status === "cancelled") {
            // Only revive CANCELLED rows as external; leave engine's own pending rows alone
            await db.execute(sql`UPDATE grid_orders SET status = 'external', exchange_status = 'open', synced_at = NOW() WHERE mexc_order_id = ${orderId}`)
            reactivated++; sr++
          } else {
            skipped++
          }
        }
        if (mexcOrders.length > 0) perSymbol.push({ symbol, mexcCount: mexcOrders.length, imported: si, reactivated: sr })
        await new Promise(r => setTimeout(r, 300))
      } catch (err) { perSymbol.push({ symbol, error: String(err) }) }
    }

    const visible = await db.select().from(gridOrders).where(inArray(gridOrders.status, ["pending", "external"]))
    return NextResponse.json({ success: true, imported, reactivated, skipped, totalVisible: visible.length, perSymbol })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    let imported = 0
    let reactivated = 0

    for (const cfg of configs) {
      try {
        const mexcOrders = await fetchOpenOrders(cfg.symbol)
        
        for (const order of mexcOrders) {
          const orderId = String(order.orderId)
          
          // Check if this order exists in DB
          const existing = await db.select().from(gridOrders).where(eq(gridOrders.mexcOrderId, orderId))
          
          if (existing.length === 0) {
            // Order not in DB - import it
            const side = order.side === 1 ? "buy" : "sell"
            const price = Number(order.price)
            const quantity = Number(order.volume)
            
            await db.insert(gridOrders).values({
              symbol: cfg.symbol,
              timeframe: cfg.timeframe,
              side,
              price,
              quantity,
              status: "pending",
              mexcOrderId: orderId,
              exchangeStatus: "open",
              createdAt: new Date(),
            })
            imported++
          } else if (existing[0].status !== "pending") {
            // Order exists but marked as cancelled/filled - reactivate it
            await db.update(gridOrders)
              .set({ status: "pending", exchangeStatus: "open" })
              .where(eq(gridOrders.mexcOrderId, orderId))
            reactivated++
          }
        }
        
        await new Promise(r => setTimeout(r, 200))
      } catch (err) {
        console.error(`Sync failed for ${cfg.symbol}:`, err)
      }
    }

    return NextResponse.json({ success: true, imported, reactivated })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

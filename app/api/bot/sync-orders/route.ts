import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    let imported = 0
    let reactivated = 0
    const details: any[] = []

    for (const cfg of configs) {
      try {
        console.log(`[Sync] Fetching open orders for ${cfg.symbol}...`)
        const mexcOrders = await fetchOpenOrders(cfg.symbol)
        console.log(`[Sync] MEXC reports ${mexcOrders.length} open orders for ${cfg.symbol}`)
        
        for (const order of mexcOrders) {
          const orderId = String(order.orderId)
          
          // Check if this order exists in DB (any status)
          const existing = await db.select().from(gridOrders).where(eq(gridOrders.mexcOrderId, orderId))
          
          if (existing.length === 0) {
            // Order not in DB at all - import it
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
            details.push({ action: "imported", symbol: cfg.symbol, orderId, side, price })
          } else if (existing[0].status !== "pending") {
            // Order exists but marked as cancelled/filled - reactivate it
            await db.update(gridOrders)
              .set({ status: "pending", exchangeStatus: "open" })
              .where(eq(gridOrders.mexcOrderId, orderId))
            reactivated++
            details.push({ action: "reactivated", symbol: cfg.symbol, orderId, oldStatus: existing[0].status })
          }
        }
        
        await new Promise(r => setTimeout(r, 300)) // Slower to avoid rate limits
      } catch (err) {
        console.error(`[Sync] Failed for ${cfg.symbol}:`, err)
        details.push({ symbol: cfg.symbol, error: String(err) })
      }
    }

    return NextResponse.json({ 
      success: true, 
      imported, 
      reactivated,
      details: details.slice(0, 20) // First 20 for readability
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

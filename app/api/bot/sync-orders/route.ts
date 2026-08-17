import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    let imported = 0
    let reactivated = 0
    let updated = 0
    const details: any[] = []

    for (const cfg of configs) {
      try {
        console.log(`[Sync] Fetching open orders for ${cfg.symbol}...`)
        const mexcOrders = await fetchOpenOrders(cfg.symbol)
        console.log(`[Sync] MEXC reports ${mexcOrders.length} open orders for ${cfg.symbol}`)
        
        for (const order of mexcOrders) {
          const orderId = String(order.orderId)
          const side = order.side === 1 ? "buy" : "sell"
          const price = Number(order.price)
          const quantity = Number(order.volume)
          
          const existing = await db.select().from(gridOrders).where(eq(gridOrders.mexcOrderId, orderId))
          
          if (existing.length === 0) {
            // Import new order
            await db.insert(gridOrders).values({
              symbol: cfg.symbol,
              timeframe: cfg.timeframe,
              side,
              price,
              quantity,
              levelIndex: -1, // -1 marks an order imported from the exchange (not part of a computed grid ladder)
              status: "pending",
              mexcOrderId: orderId,
              exchangeStatus: "open",
              createdAt: new Date(),
              syncedAt: sql`NOW()`,
            })
            imported++
            details.push({ action: "imported", symbol: cfg.symbol, orderId, side, price })
          } else {
            // Update existing order to pending + mark as synced
            await db.update(gridOrders)
              .set({ 
                status: "pending", 
                exchangeStatus: "open",
                syncedAt: sql`NOW()`
              })
              .where(eq(gridOrders.mexcOrderId, orderId))
            
            if (existing[0].status !== "pending") {
              reactivated++
              details.push({ action: "reactivated", symbol: cfg.symbol, orderId, oldStatus: existing[0].status })
            } else {
              updated++
            }
          }
        }
        
        await new Promise(r => setTimeout(r, 300))
      } catch (err) {
        console.error(`[Sync] Failed for ${cfg.symbol}:`, err)
        details.push({ symbol: cfg.symbol, error: String(err) })
      }
    }

    return NextResponse.json({ 
      success: true, 
      imported, 
      reactivated,
      updated,
      details: details.slice(0, 20)
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

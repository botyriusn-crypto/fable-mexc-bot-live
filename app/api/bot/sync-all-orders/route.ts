import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders } from "@/lib/db/schema"
import { sql } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const allOrders: any[] = []
    
    // Get all unique symbols from existing orders
    const existingSymbols = await db.select({ symbol: gridOrders.symbol })
      .from(gridOrders)
      .groupBy(gridOrders.symbol)
    
    const symbols = [...new Set(existingSymbols.map(s => s.symbol))]
    console.log(`[SyncAll] Checking ${symbols.length} known symbols`)
    
    let imported = 0
    let reactivated = 0
    
    for (const symbol of symbols) {
      try {
        const orders = await fetchOpenOrders(symbol)
        console.log(`[SyncAll] ${symbol}: ${orders.length} open orders`)
        
        for (const order of orders) {
          const orderId = String(order.orderId)
          const existing = await db.select().from(gridOrders).where(sql`${gridOrders.mexcOrderId} = ${orderId}`)
          
          if (existing.length === 0) {
            const side = order.side === 1 ? "buy" : "sell"
            await db.insert(gridOrders).values({
              symbol,
              timeframe: "Min15",
              side,
              price: Number(order.price),
              quantity: Number(order.volume),
              status: "pending",
              mexcOrderId: orderId,
              exchangeStatus: "open",
              createdAt: new Date(),
            })
            imported++
          } else if (existing[0].status !== "pending") {
            await db.update(gridOrders)
              .set({ status: "pending", exchangeStatus: "open" })
              .where(sql`${gridOrders.mexcOrderId} = ${orderId}`)
            reactivated++
          }
        }
        
        await new Promise(r => setTimeout(r, 500))
      } catch (err) {
        console.error(`[SyncAll] Failed for ${symbol}:`, err)
      }
    }
    
    const pendingCount = await db.select().from(gridOrders).where(sql`${gridOrders.status} = 'pending'`)
    
    return NextResponse.json({ 
      success: true, 
      imported,
      reactivated,
      totalPending: pendingCount.length
    })
  } catch (err: any) {
    console.error('[SyncAll] Error:', err)
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

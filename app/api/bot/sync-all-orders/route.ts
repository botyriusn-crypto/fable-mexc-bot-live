import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders, gridConfigs } from "@/lib/db/schema"
import { sql, eq } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const enabledConfigs = await db.select({ symbol: gridConfigs.symbol })
      .from(gridConfigs)
      .where(eq(gridConfigs.enabled, true))
    
    const historicalSymbols = await db.select({ symbol: gridOrders.symbol })
      .from(gridOrders)
      .groupBy(gridOrders.symbol)
    
    const allSymbols = [...new Set([
      ...enabledConfigs.map(c => c.symbol),
      ...historicalSymbols.map(s => s.symbol)
    ])]
    
    console.log(`[SyncAll] Checking ${allSymbols.length} symbols: ${allSymbols.join(', ')}`)
    
    let imported = 0
    let reactivated = 0
    let skipped = 0
    const perSymbol: any[] = []
    
    for (const symbol of allSymbols) {
      try {
        const mexcOrders = await fetchOpenOrders(symbol)
        
        let symbolImported = 0
        let symbolReactivated = 0
        
        for (const order of mexcOrders) {
          const orderId = String(order.orderId)
          const side = order.side === 1 ? "buy" : "sell"
          const price = Number(order.price)
          const quantity = Number(order.volume)
          
          const existing = await db.select().from(gridOrders)
            .where(sql`${gridOrders.mexcOrderId} = ${orderId}`)
          
          if (existing.length === 0) {
            await db.insert(gridOrders).values({
              symbol,
              timeframe: "Min15",
              side,
              price,
              quantity,
              status: "pending",
              mexcOrderId: orderId,
              exchangeStatus: "open",
              createdAt: new Date(),
              syncedAt: sql`NOW()`,
            })
            imported++
            symbolImported++
          } else if (existing[0].status !== "pending") {
            await db.update(gridOrders)
              .set({ 
                status: "pending", 
                exchangeStatus: "open",
                syncedAt: sql`NOW()`,
              })
              .where(sql`${gridOrders.mexcOrderId} = ${orderId}`)
            reactivated++
            symbolReactivated++
          } else {
            skipped++
          }
        }
        
        if (mexcOrders.length > 0 || symbolImported > 0 || symbolReactivated > 0) {
          perSymbol.push({
            symbol,
            mexcCount: mexcOrders.length,
            imported: symbolImported,
            reactivated: symbolReactivated
          })
        }
        
        await new Promise(r => setTimeout(r, 400))
      } catch (err) {
        console.error(`[SyncAll] Failed for ${symbol}:`, err)
        perSymbol.push({ symbol, error: String(err) })
      }
    }
    
    const pendingCount = (await db.select().from(gridOrders).where(sql`${gridOrders.status} = 'pending'`)).length
    
    return NextResponse.json({ 
      success: true, 
      symbolsChecked: allSymbols.length,
      imported,
      reactivated,
      skipped,
      totalPending: pendingCount,
      perSymbol
    })
  } catch (err: any) {
    console.error('[SyncAll] Error:', err)
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

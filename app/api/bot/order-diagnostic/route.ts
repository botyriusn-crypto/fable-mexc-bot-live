import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, and, inArray } from "drizzle-orm"
import { fetchOpenOrders, fetchOrderStatus } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    const report: any = []

    for (const cfg of configs) {
      try {
        // Get live orders from MEXC
        const mexcOrders = await fetchOpenOrders(cfg.symbol)
        
        // Get DB orders for this symbol
        const dbOrders = await db.select().from(gridOrders).where(
          and(eq(gridOrders.symbol, cfg.symbol), eq(gridOrders.status, "pending"))
        )

        const dbMexcIds = new Set(dbOrders.map(o => String(o.mexcOrderId)))
        const mexcIds = new Set(mexcOrders.map((o: any) => String(o.orderId)))

        // Orders on MEXC but not in DB (or marked cancelled in DB)
        const missing = mexcOrders.filter((o: any) => !dbMexcIds.has(String(o.orderId)))
        
        // Orders in DB but not on MEXC
        const extra = dbOrders.filter(o => !mexcIds.has(String(o.mexcOrderId)))

        // Check a few sample order statuses
        const samples = mexcOrders.slice(0, 3).map(async (o: any) => {
          const status = await fetchOrderStatus(String(o.orderId))
          return { orderId: o.orderId, state: status?.state, status: status?.status }
        })

        report.push({
          symbol: cfg.symbol,
          mexcCount: mexcOrders.length,
          dbPendingCount: dbOrders.length,
          missingFromDb: missing.length,
          extraInDb: extra.length,
          samples: await Promise.all(samples)
        })

        await new Promise(r => setTimeout(r, 200))
      } catch (err) {
        report.push({ symbol: cfg.symbol, error: String(err) })
      }
    }

    return NextResponse.json(report)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 })
  }
}

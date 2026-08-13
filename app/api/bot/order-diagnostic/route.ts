import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { fetchOpenOrders } from "@/lib/mexc/private"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    const report: any = {
      enabledPairs: configs.length,
      totalMexcOrders: 0,
      perSymbol: [],
      dbPending: 0,
    }

    for (const cfg of configs) {
      try {
        const mexcOrders = await fetchOpenOrders(cfg.symbol)
        report.perSymbol.push({
          symbol: cfg.symbol,
          mexcCount: mexcOrders.length,
          sample: mexcOrders.length > 0 ? mexcOrders[0] : null
        })
        report.totalMexcOrders += mexcOrders.length
        await new Promise(r => setTimeout(r, 500))
      } catch (err) {
        report.perSymbol.push({ symbol: cfg.symbol, error: String(err) })
      }
    }

    const dbPending = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
    report.dbPending = dbPending.length

    return NextResponse.json(report)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 })
  }
}

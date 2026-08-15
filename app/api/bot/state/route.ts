import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, gridOrders, trades, positions } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const configs = await db.select().from(botConfig).where(eq(botConfig.id, 1))
    const config = configs[0]

    if (!config) {
      return NextResponse.json({ error: "Config not found" }, { status: 404 })
    }

    const allTrades = await db.select().from(trades).orderBy(desc(trades.closedAt)).limit(100)
    const allPositions = await db.select().from(positions)
    const allGridOrders = await db.select().from(gridOrders)

    return NextResponse.json({
      config,
      trades: allTrades || [],
      positions: allPositions || [],
      gridOrders: allGridOrders || [],
      openOrders: allGridOrders.filter(o => o.status === "active") || [],
      balance: {
        available: config.paperBalance || 0,
        total: config.paperBalance || 0,
      },
      pnl: {
        total: allTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0),
        today: 0,
        unrealized: 0,
      },
      equity: config.paperBalance || 0,
      marketData: [],
      logs: [],
    })
  } catch (error) {
    console.error("State endpoint error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

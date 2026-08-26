import { NextResponse } from "next/server"
import { getExchangeClient } from "@/lib/exchange"
import { db } from "@/lib/db"
import { botConfig, trades, gridOrders } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET() {
  try {
    const cfg = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
    const exchangeName = (cfg[0]?.exchange ?? "mexc") as "mexc" | "gate" | "bybit"
    const exchange = getExchangeClient(exchangeName)

    let assets: unknown = null
    let positions: unknown = null
    let assetError: string | null = null
    let positionError: string | null = null

    try {
      assets = await exchange.getAccountAssets()
    } catch (err: any) {
      assetError = err.message
    }
    try {
      positions = await exchange.getOpenPositions()
    } catch (err: any) {
      positionError = err.message
    }

    const recentTrades = await db.select().from(trades).orderBy(sql`id DESC`).limit(15)
    const pendingOrders = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))

    return NextResponse.json({
      exchange: exchangeName,
      assets,
      positions,
      assetError,
      positionError,
      bot_paper_balance: cfg[0]?.paperBalance,
      bot_pending_orders_count: pendingOrders.length,
      bot_recent_trades: recentTrades,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

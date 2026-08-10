import { NextResponse } from "next/server"
import { getExchangeClient } from "@/lib/exchange"
import { db } from "@/lib/db"
import { botConfig, trades, gridOrders } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError
  try {
    const exchange = getExchangeClient("mexc")
    // 1. Ask MEXC for actual account balance
    const assets = await exchange.getAccountAssets()
    // 2. Ask MEXC for actual open positions
    const positions = await exchange.getOpenPositions()
    // 3. Ask Bot for its internal state
    const cfg = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
    const recentTrades = await db.select().from(trades).orderBy(sql`id DESC`).limit(15)
    const pendingOrders = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
    
    return NextResponse.json({
      mexc_assets: assets,
      mexc_positions: positions,
      bot_paper_balance: cfg[0]?.paperBalance,
      bot_pending_orders_count: pendingOrders.length,
      bot_recent_trades: recentTrades
    })
  } catch (err: any) {
    console.error('[Diagnose] Error:', err)
    return NextResponse.json({ error: 'Diagnosis failed' }, { status: 500 })
  }
}

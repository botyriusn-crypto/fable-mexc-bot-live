import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, trades, gridOrders } from "@/lib/db/schema"
import { eq, desc, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET() {
  const config = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
  const allTrades = await db.select({ 
    pnl: trades.pnl, 
    fees: trades.fees,
    symbol: trades.symbol,
    side: trades.side,
    exitReason: trades.exitReason,
    strategy: trades.strategy
  }).from(trades).orderBy(desc(trades.closedAt)).limit(20)
  
  const openOrders = await db.select({
    symbol: gridOrders.symbol,
    side: gridOrders.side,
    price: gridOrders.price,
    quantity: gridOrders.quantity,
    status: gridOrders.status
  }).from(gridOrders).where(eq(gridOrders.status, "pending"))

  const totalRealizedPnl = await db.select({ value: sql<number>`sum(${trades.pnl})` }).from(trades)
  const totalFees = await db.select({ value: sql<number>`sum(${trades.fees})` }).from(trades)

  return NextResponse.json({
    currentPaperBalance: config[0]?.paperBalance,
    startingBalance: config[0]?.paperStartingBalance,
    totalRealizedPnl: totalRealizedPnl[0]?.value || 0,
    totalFees: totalFees[0]?.value || 0,
    recentTrades: allTrades,
    openOrdersCount: openOrders.length,
    openOrders: openOrders
  }, null, 2)
}

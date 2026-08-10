import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, trades, gridOrders } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { livePrices } from "@/lib/mexc/ws"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    // Your confirmed baseline from yesterday
    const INITIAL_EQUITY = 10104.00 
    
    // 1. Sum all realized PnL (net of fees) from the trades table
    const tradeStats = await db.select({
      totalPnl: sql`COALESCE(SUM(${trades.pnl}), 0)`
    }).from(trades)
    
    const realizedPnl = Number(tradeStats[0]?.totalPnl || 0)
    const trueEquity = INITIAL_EQUITY + realizedPnl
    
    // 2. Calculate True Unrealized PnL from open grid positions
    const openOrders = await db.select().from(gridOrders).where(eq(gridOrders.status, 'filled'))
    let unrealizedPnl = 0
    
    for (const o of openOrders) {
      const currentPrice = livePrices[o.symbol]
      if (!currentPrice || !o.price || !o.quantity) continue
      
      // Short position (sell to open): profit if price drops
      if (o.side === 'sell') {
        unrealizedPnl += (o.price - currentPrice) * o.quantity
      } 
      // Long position (buy to open): profit if price rises
      else if (o.side === 'buy') {
        unrealizedPnl += (currentPrice - o.price) * o.quantity
      }
    }
    
    // 3. Update botConfig with the rescued equity
    await db.update(botConfig).set({ 
      paperBalance: trueEquity,
      updatedAt: new Date()
    }).where(eq(botConfig.id, 1))
    
    return NextResponse.json({ 
      success: true, 
      initial: INITIAL_EQUITY,
      realizedPnl: realizedPnl.toFixed(2),
      unrealizedPnl: unrealizedPnl.toFixed(2),
      rescuedEquity: trueEquity.toFixed(2),
      message: "Equity rescued! Margin deductions disabled."
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}

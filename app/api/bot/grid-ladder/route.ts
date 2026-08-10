import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { cancelOrders } from "@/lib/mexc/private"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

export async function DELETE(request: NextRequest) {
  // Verify API key authentication
  const authError = verifyApiKey(request)
  if (authError) return authError
  
  try {
    const { searchParams } = new URL(request.url)
    const symbol = searchParams.get("symbol")
    const timeframe = searchParams.get("timeframe")
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }

    const pending = await db.select().from(gridOrders)
      .where(and(
        eq(gridOrders.symbol, symbol),
        eq(gridOrders.timeframe, timeframe),
        eq(gridOrders.status, "pending")
      ))

    const mexOrderIds = pending.filter((o: any) => o.mexcOrderId).map((o: any) => o.mexcOrderId!) as string[]
    if (mexOrderIds.length > 0) {
      try {
        await cancelOrders(mexOrderIds)
        console.log(`Cleared ${mexOrderIds.length} exchange orders for ${symbol}`)
      } catch (err: any) {
        console.error(`Failed to cancel exchange orders: ${err?.message || err}`)
      }
    }

    await db.update(gridOrders)
      .set({ status: "cancelled" })
      .where(and(
        eq(gridOrders.symbol, symbol),
        eq(gridOrders.timeframe, timeframe),
        eq(gridOrders.status, "pending")
      ))

    return NextResponse.json({ ok: true, cancelled: pending.length })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown" }, { status: 500 })
  }
}

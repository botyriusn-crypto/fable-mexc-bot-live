import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridOrders, gridConfigs, botConfig } from "@/lib/db/schema"
import { eq, and, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const symbol = searchParams.get("symbol")
    const timeframe = searchParams.get("timeframe")
    const forceSync = searchParams.get("sync") === "true"
    
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }
    
    // Force sync if requested - import dynamically to avoid circular deps
    if (forceSync) {
      try {
        const { syncExchangeState } = await import("@/lib/grid")
        await syncExchangeState()
      } catch (err) {
        console.error("Sync failed:", err)
      }
    }
    
    // Get all orders for this symbol
    const allOrders = await db.select().from(gridOrders)
      .where(and(
        eq(gridOrders.symbol, symbol),
        eq(gridOrders.timeframe, timeframe)
      ))
      .orderBy(gridOrders.price)
    
    // Separate by status
    const pending = allOrders.filter(o => o.status === "pending")
    const filled = allOrders.filter(o => o.status === "filled")
    const cancelled = allOrders.filter(o => o.status === "cancelled")
    
    // Group by side
    const buys = pending.filter(o => o.side === "buy")
    const sells = pending.filter(o => o.side === "sell")
    
    return NextResponse.json({
      symbol,
      timeframe,
      pending: {
        buy: buys,
        sell: sells,
        total: pending.length
      },
      filled: {
        total: filled.length
      },
      cancelled: {
        total: cancelled.length
      },
      all: allOrders
    })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
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
        const { cancelOrders } = await import("@/lib/mexc/private")
        await cancelOrders(mexOrderIds)
        console.log(`Cleared ${mexOrderIds.length} exchange orders for ${symbol}`)
      } catch (err: any) {
        console.error(`Failed to cancel exchange orders: ${err?.message || err}`)
      }
    }

    await db.update(gridOrders)
      .set({ status: "cancelled", exchangeStatus: "cancelled" })
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

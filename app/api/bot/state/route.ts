import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, gridOrders, trades, gridConfigs } from "@/lib/db/schema"
import { eq, sql, desc, and } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    // Get bot config
    const configs = await db.select().from(botConfig).where(eq(botConfig.id, 1))
    const cfg = configs[0] || { mode: "paper", status: "stopped", paperBalance: 10000 }
    const isLive = cfg.mode === "live"
    
    // Get balance based on mode
    let balance = { available: 0, total: 0, locked: 0, unrealized: 0 }
    
    if (isLive) {
      try {
        const { getAccountAssets } = await import("@/lib/mexc/private")
        const assets = await getAccountAssets()
        
        if (Array.isArray(assets) && assets.length > 0) {
          const usdt = assets.find((a: any) => a.currency === "USDT")
          if (usdt) {
            balance = {
              available: Number(usdt.availableBalance) || 0,
              total: Number(usdt.equity) || 0,
              locked: Number(usdt.positionMargin) || 0,
              unrealized: Number(usdt.unrealized) || 0,
            }
          }
        }
      } catch (err: any) {
        console.error("Failed to fetch live balance:", err?.message || err)
        // Fallback to paper balance if live fetch fails
        balance = { available: Number(cfg.paperBalance) || 0, total: Number(cfg.paperBalance) || 0, locked: 0, unrealized: 0 }
      }
    } else {
      balance = {
        available: Number(cfg.paperBalance) || 0,
        total: Number(cfg.paperBalance) || 0,
        locked: 0,
        unrealized: 0,
      }
    }
    
    // Get trades - ONLY live trades in live mode, ONLY paper trades in paper mode
    const liveFlag = isLive ? true : false
    const allTrades = await db.select().from(trades)
      .where(eq(trades.live, liveFlag))
      .orderBy(desc(trades.createdAt))
    
    const totalPnl = allTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0)
    const wins = allTrades.filter(t => Number(t.pnl || 0) > 0).length
    const winRate = allTrades.length > 0 ? Math.round((wins / allTrades.length) * 100) : 0
    
    // Get active positions (pending orders)
    const positions = await db.select().from(gridOrders)
      .where(eq(gridOrders.status, "pending"))
      .orderBy(desc(gridOrders.id))
      .limit(100)
    
    // Get enabled grids
    const grids = await db.select({
      symbol: gridConfigs.symbol,
      enabled: gridConfigs.enabled,
      paused: gridConfigs.paused,
      direction: gridConfigs.direction,
      levels: gridConfigs.levels,
    }).from(gridConfigs)
      .where(eq(gridConfigs.enabled, true))
    
    // Get pending orders count by symbol
    const pendingBySymbol = await db.select({
      symbol: gridOrders.symbol,
      count: sql<number>`count(*)`,
    })
      .from(gridOrders)
      .where(eq(gridOrders.status, "pending"))
      .groupBy(gridOrders.symbol)
    
    return NextResponse.json({
      status: cfg.status || "running",
      mode: cfg.mode || "paper",
      balance,
      trades: allTrades.slice(0, 20), // Last 20 trades
      tradeStats: {
        total: allTrades.length,
        wins,
        losses: allTrades.length - wins,
        winRate,
        totalPnl,
      },
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        price: p.price,
        quantity: p.quantity,
        status: p.status,
      })),
      grids,
      pendingOrders: pendingBySymbol,
    })
  } catch (err: any) {
    console.error("State endpoint error:", err)
    return NextResponse.json({ 
      error: err?.message || "Unknown",
      status: "error",
      mode: "paper",
      balance: { available: 0, total: 0, locked: 0, unrealized: 0 }
    }, { status: 500 })
  }
}

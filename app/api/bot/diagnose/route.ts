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

    let assets: any = null
    let positions: any = null
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

    // ── Build a short, plain-English summary ──────────────────────────
    const lines: string[] = []
    lines.push(`Exchange: ${exchangeName}`)

    if (assetError) {
      lines.push(`Balance: error (${assetError})`)
    } else if (Array.isArray(assets) && assets.length > 0) {
      const a = assets[0]
      const equity = Number(a?.equity ?? 0)
      const available = Number(a?.availableBalance ?? 0)
      lines.push(`Balance: ${a?.currency ?? "USDT"} ${equity.toFixed(4)} total, ${available.toFixed(4)} available`)
    } else {
      lines.push(`Balance: none reported`)
    }

    if (positionError) {
      lines.push(`Open positions: error (${positionError})`)
    } else {
      const n = Array.isArray(positions) ? positions.length : 0
      lines.push(`Open positions: ${n}`)
    }

    lines.push(`Paper balance: ${Number(cfg[0]?.paperBalance ?? 0).toFixed(2)}`)
    lines.push(`Pending orders: ${pendingOrders.length}`)
    lines.push(`Recent trades: ${recentTrades.length}`)

    return NextResponse.json({ summary: lines.join("\n") })
  } catch (err: any) {
    return NextResponse.json({ summary: `Error: ${err.message}` }, { status: 500 })
  }
}

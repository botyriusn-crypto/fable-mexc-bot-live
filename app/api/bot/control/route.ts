import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, positions, equitySnapshots, botLogs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { getConfig, closePosition } from "@/lib/engine"
import { teardownGrid } from "@/lib/grid"
import { fetchTicker } from "@/lib/mexc/public"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

// Actions: start | stop | close_position | reset_paper | set_mode
export async function POST(request: NextRequest) {
  // Verify API key authentication
  const authError = verifyApiKey(request)
  if (authError) return authError
  
  try {
    const body = (await request.json()) as { action: string; mode?: string; positionId?: number }

    // Validate action is a string
    if (typeof body.action !== 'string') {
      return NextResponse.json({ error: "Invalid action format" }, { status: 400 })
    }

    switch (body.action) {
      case "start": {
        await db.update(botConfig).set({ status: "running", updatedAt: sql`NOW()` }).where(eq(botConfig.id, 1))
        await db.insert(botLogs).values({ level: "info", message: "Bot started" })
        return NextResponse.json({ ok: true })
      }
      case "stop": {
        await db.update(botConfig).set({ status: "stopped", updatedAt: sql`NOW()` }).where(eq(botConfig.id, 1))
        await db.insert(botLogs).values({ level: "info", message: "Bot stopped" })
        return NextResponse.json({ ok: true })
      }
      case "close_position": {
        // Validate positionId is a number if provided
        if (body.positionId !== undefined && typeof body.positionId !== 'number') {
          return NextResponse.json({ error: "Invalid positionId format" }, { status: 400 })
        }
        const cfg = await getConfig()
        const open = await db.select().from(positions).where(eq(positions.status, "open"))
        const target = body.positionId ? open.find((position) => position.id === body.positionId) : open[0]
        if (!target) return NextResponse.json({ error: "Open position not found" }, { status: 400 })
        const ticker = await fetchTicker(target.symbol)
        await closePosition(target, ticker.lastPrice, "manual", { ...cfg, symbol: target.symbol, timeframe: target.timeframe })
        return NextResponse.json({ ok: true })
      }
      case "reset_paper": {
        const cfg = await getConfig()
        await db
          .update(positions)
          .set({ status: "closed", closedAt: sql`NOW()` })
          .where(eq(positions.status, "open"))
        await db
          .update(botConfig)
          .set({ paperBalance: cfg.paperStartingBalance, updatedAt: sql`NOW()` })
          .where(eq(botConfig.id, 1))
        await db.delete(equitySnapshots)
        await db.insert(botLogs).values({ level: "info", message: "Paper account reset" })
        return NextResponse.json({ ok: true })
      }
      case "set_mode": {
        if (body.mode !== "paper" && body.mode !== "live") {
          return NextResponse.json({ error: "Invalid mode" }, { status: 400 })
        }
        if (body.mode === "live" && (!process.env.MEXC_API_KEY || !process.env.MEXC_API_SECRET)) {
          return NextResponse.json(
            { error: "MEXC_API_KEY and MEXC_API_SECRET must be set for live mode" },
            { status: 400 },
          )
        }
        await db.update(botConfig).set({ mode: body.mode, updatedAt: sql`NOW()` }).where(eq(botConfig.id, 1))
        await db.insert(botLogs).values({
          level: "info",
          message: `Mode switched to ${body.mode.toUpperCase()}`,
        })
        return NextResponse.json({ ok: true })
      }
      case "grid_on": {
        await db
          .update(botConfig)
          .set({ gridEnabled: true, gridCenter: null, gridLower: null, gridUpper: null, gridPaused: false, updatedAt: sql`NOW()` })
          .where(eq(botConfig.id, 1))
        await db.insert(botLogs).values({ level: "info", message: "Grid bot enabled — ladder will be set up on next tick" })
        return NextResponse.json({ ok: true })
      }
      case "grid_off": {
        const cfg = await getConfig()
        let price: number | null = null
        try {
          const ticker = await fetchTicker(cfg.symbol)
          price = ticker.lastPrice
        } catch {
          // price unavailable — teardown will cancel buys but cannot liquidate
        }
        await teardownGrid(cfg, price)
        await db
          .update(botConfig)
          .set({ gridEnabled: false, updatedAt: sql`NOW()` })
          .where(eq(botConfig.id, 1))
        await db.insert(botLogs).values({ level: "info", message: "Grid bot disabled" })
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

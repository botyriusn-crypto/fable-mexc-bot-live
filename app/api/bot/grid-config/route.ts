import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { gridConfigs, gridOrders } from "@/lib/db/schema"
import { eq, and, inArray } from "drizzle-orm"
import { cancelOrders } from "@/lib/mexc/private"
import { log } from "@/lib/grid"

export const dynamic = "force-dynamic"

// ========== SMART DEFAULTS TEMPLATE ==========
// These are the optimal starting values applied to every new pair.
// The grid tick will auto-adjust ATR multiplier and levels based on regime.
const GRID_TEMPLATE = {
  levels: 5,
  rangeAtrMult: 1.5,       // Start at 1.5x — grid will auto-tune
  budgetPct: 5,
  leverage: 3,
  feeMarginMult: 3,
  autoPause: true,
  makerMode: true,         // Default to maker for all new pairs
  direction: "long",
}

export async function GET() {
  try {
    const rows = await db.select().from(gridConfigs).orderBy(gridConfigs.symbol)
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe } = body
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }
    const existing = await db.select().from(gridConfigs)
      .where(and(eq(gridConfigs.symbol, symbol.toUpperCase()), eq(gridConfigs.timeframe, timeframe)))
      .limit(1)
    if (existing.length > 0) {
      return NextResponse.json({ error: "This pair already exists" }, { status: 409 })
    }
    await db.insert(gridConfigs).values({
      symbol: symbol.toUpperCase(),
      timeframe,
      enabled: false,
      levels: GRID_TEMPLATE.levels,
      rangeAtrMult: GRID_TEMPLATE.rangeAtrMult,
      budgetPct: GRID_TEMPLATE.budgetPct,
      leverage: GRID_TEMPLATE.leverage,
      feeMarginMult: GRID_TEMPLATE.feeMarginMult,
      autoPause: GRID_TEMPLATE.autoPause,
      makerMode: body.makerMode !== undefined ? body.makerMode : GRID_TEMPLATE.makerMode,
      direction: body.direction || GRID_TEMPLATE.direction,
    })
    await log("info", `Grid template applied to ${symbol.toUpperCase()}: levels=${GRID_TEMPLATE.levels} atrMult=${GRID_TEMPLATE.rangeAtrMult}x budget=${GRID_TEMPLATE.budgetPct}% leverage=${GRID_TEMPLATE.leverage}x maker=${GRID_TEMPLATE.makerMode}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
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
      .where(and(eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe), eq(gridOrders.status, "pending")))
    if (pending.length > 0) {
      return NextResponse.json({
        error: `Cannot delete: ${pending.length} pending order(s)/position still open. Disable the pair and wait for them to close first.`,
      }, { status: 409 })
    }

    await db.delete(gridConfigs)
      .where(and(eq(gridConfigs.symbol, symbol), eq(gridConfigs.timeframe, timeframe)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe, ...updates } = body
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }
    const cfg = await db.select().from(gridConfigs)
      .where(and(eq(gridConfigs.symbol, symbol), eq(gridConfigs.timeframe, timeframe)))
      .limit(1)
    if (cfg.length === 0) {
      return NextResponse.json({ error: "Grid config not found" }, { status: 404 })
    }
    await db.update(gridConfigs)
      .set(updates)
      .where(and(eq(gridConfigs.symbol, symbol), eq(gridConfigs.timeframe, timeframe)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

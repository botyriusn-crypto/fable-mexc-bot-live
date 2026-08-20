import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, gridConfigs, botLogs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { teardownGrid, getGridConfigs } from "@/lib/grid"
import { getConfig, stopRealtimeEngine } from "@/lib/engine"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    await db.update(botConfig)
      .set({ gridEnabled: false, updatedAt: sql`NOW()` })
      .where(eq(botConfig.id, 1))

    await db.update(gridConfigs)
      .set({ enabled: false, paused: true })
      .where(eq(gridConfigs.enabled, true))

    const cfg = await getConfig()
    const gridCfgs = await getGridConfigs()
    for (const gc of gridCfgs) {
      try {
        const gridCfg = { ...cfg, symbol: gc.symbol, timeframe: gc.timeframe } as any
        await teardownGrid(gridCfg, null)
      } catch (err) {
        console.error(`[stop] teardown failed for ${gc.symbol}:`, err)
      }
    }

    const managers = (globalThis as any).__wsManagers || {}
    for (const symbol of Object.keys(managers)) {
      await stopRealtimeEngine(symbol)
    }

    await db.insert(botLogs).values({
      level: "info",
      message: "🛑 Grid STOP: all grids disabled, ladders torn down, kill-switch persisted",
    })
    return NextResponse.json({ ok: true, disabled: gridCfgs.length })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

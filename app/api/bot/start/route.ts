import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, botLogs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    await db.update(botConfig)
      .set({ gridEnabled: true, updatedAt: sql`NOW()` })
      .where(eq(botConfig.id, 1))
    await db.insert(botLogs).values({
      level: "info",
      message: "▶️ Grid START: kill-switch cleared (grids remain disabled until re-enabled manually)",
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, botLogs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

const NUMERIC_FIELDS = [
  "htfEmaFast",
  "htfEmaSlow",
  "mtfMinAlignment",
  "fundingLongThreshold",
  "fundingShortThreshold",
  "oiDeltaThresholdPct",
  "cvdZThreshold",
  "baseRiskPct",
  "maxRiskPct",
  "confidenceFloor",
  "maxPositionPct",
] as const

const BOOL_FIELDS = [
  "enabled",
  "mtfEnabled",
  "smartMoneyEnabled",
  "dynamicSizingEnabled",
] as const

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const updates: Record<string, unknown> = {}

    for (const f of NUMERIC_FIELDS) {
      if (typeof body[f] === "number" && Number.isFinite(body[f])) {
        updates[`advanced${f[0].toUpperCase()}${f.slice(1)}`] = body[f]
      }
    }
    for (const f of BOOL_FIELDS) {
      if (typeof body[f] === "boolean") {
        updates[`advanced${f[0].toUpperCase()}${f.slice(1)}`] = body[f]
      }
    }
    if (typeof body.htfTimeframe === "string") updates.advancedHtfTimeframe = body.htfTimeframe

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields" }, { status: 400 })
    }

    updates.updatedAt = sql`NOW()`
    await db.update(botConfig).set(updates).where(eq(botConfig.id, 1))
    await db.insert(botLogs).values({
      level: "info",
      message: "Advanced strategy settings updated",
      details: updates as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

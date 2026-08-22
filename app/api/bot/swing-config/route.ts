import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [cfg] = await db.select().from(botConfig).limit(1)
    if (!cfg) {
      return NextResponse.json({ error: "Config not found" }, { status: 404 })
    }
    return NextResponse.json({
      enabled: cfg.swingEnabled,
      riskPct: cfg.swingRiskPct,
      symbols: cfg.swingSymbols,
      leverage: cfg.swingLeverage,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { enabled, riskPct, symbols, leverage } = body

    const [cfg] = await db.select().from(botConfig).limit(1)
    if (!cfg) {
      return NextResponse.json({ error: "Config not found" }, { status: 404 })
    }

    await db.update(botConfig)
      .set({
        swingEnabled: enabled !== undefined ? enabled : cfg.swingEnabled,
        swingRiskPct: riskPct !== undefined ? riskPct : cfg.swingRiskPct,
        swingSymbols: symbols !== undefined ? symbols : cfg.swingSymbols,
        swingLeverage: leverage !== undefined ? leverage : cfg.swingLeverage,
      })
      .where(eq(botConfig.id, cfg.id))

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

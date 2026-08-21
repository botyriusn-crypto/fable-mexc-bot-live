import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1))
    if (rows.length === 0) {
      return NextResponse.json({ error: "Bot config not found" }, { status: 404 })
    }
    const c = rows[0]
    const config = {
      enabled: c.advancedEnabled,
      mtfEnabled: c.advancedMtfEnabled,
      htfTimeframe: c.advancedHtfTimeframe,
      htfEmaFast: c.advancedHtfEmaFast,
      htfEmaSlow: c.advancedHtfEmaSlow,
      mtfMinAlignment: c.advancedMtfMinAlignment,
      smartMoneyEnabled: c.advancedSmartMoneyEnabled,
      fundingLongThreshold: c.advancedFundingLongThreshold,
      fundingShortThreshold: c.advancedFundingShortThreshold,
      oiDeltaThresholdPct: c.advancedOiDeltaThresholdPct,
      cvdZThreshold: c.advancedCvdZThreshold,
      dynamicSizingEnabled: c.advancedDynamicSizingEnabled,
      baseRiskPct: c.advancedBaseRiskPct,
      maxRiskPct: c.advancedMaxRiskPct,
      confidenceFloor: c.advancedConfidenceFloor,
      maxPositionPct: c.advancedMaxPositionPct,
    }
    return NextResponse.json({ config, signal: null })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

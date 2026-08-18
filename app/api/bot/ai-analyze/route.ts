import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { analyzeTradesForMarket, applyRecommendations } from "@/lib/ai-advisor"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const cfg = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
    if (!cfg.length) return NextResponse.json({ error: "Config not found" }, { status: 500 })

    const config = cfg[0]
    const result = await analyzeTradesForMarket(config.symbol, config.timeframe)

    // Apply the recommendations through the levers (guardrails) so a manual
    // "run analysis" actually tunes the bot — not just preview it.
    let applied = false
    if (result?.recommendations?.length) {
      applied = await applyRecommendations(0, result.recommendations)
    }

    return NextResponse.json({ ...result, applied })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Analysis failed" }, { status: 500 })
  }
}

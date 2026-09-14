import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { analyzeTradesForMarket } from "@/lib/ai-advisor"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const cfg = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
    if (!cfg.length) return NextResponse.json({ error: "Config not found" }, { status: 500 })

    const config = cfg[0]
    const result = await analyzeTradesForMarket(config.symbol, config.timeframe)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed"
    // Insufficient trade history is a normal, expected state — not a server error.
    if (message.startsWith("Need at least")) {
      return NextResponse.json({ error: message, insufficientData: true }, { status: 200 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { db } from "./db"
import { botLogs } from "./db/schema"
import { eq, lt, sql } from "drizzle-orm"
import { livePrices } from "./mexc/ws"

export async function evaluateAiPicks() {
  try {
    // Find AI picks older than 30 minutes that haven't been evaluated
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000)
    const pendingPicks = await db.select().from(botLogs).where(
      sql`${botLogs.level} = 'ai_pick' AND ${botLogs.createdAt} < ${thirtyMinAgo} AND ${botLogs.details}->>'evaluated' IS NULL`
    )

    for (const pick of pendingPicks) {
      const details = pick.details as any
      const currentPrice = livePrices[details.symbol]
      
      if (currentPrice) {
        const entryPrice = details.entryPrice
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100
        const result = pnlPct >= 0 ? "WIN" : "LOSS"
        
        // Log the outcome
        await db.insert(botLogs).values({
          level: "info",
          message: `AI Feedback: ${details.symbol} pick from 30m ago resulted in ${result} (${pnlPct.toFixed(2)}%)`,
          details: { symbol: details.symbol, entryPrice, currentPrice, pnlPct, result }
        })
      }
      
      // Mark the original pick as evaluated
      await db.update(botLogs).set({
        details: sql`jsonb_set(${botLogs.details}, '{evaluated}', 'true')`
      }).where(eq(botLogs.id, pick.id))
    }
  } catch (err) {
    console.error("[AI Feedback] Evaluation failed:", err)
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { mlModel, classifierDecisions, trades, botConfig } from "@/lib/db/schema"
import { eq, desc, sql } from "drizzle-orm"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError
  const cfg = (await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1))[0]
  const model = (await db.select().from(mlModel).where(eq(mlModel.id, 1)).limit(1))[0]
  const decisions = await db.select().from(classifierDecisions).orderBy(desc(classifierDecisions.createdAt)).limit(200)
  const sel = decisions.filter(d => d.symbol === cfg?.symbol && d.timeframe === cfg?.timeframe)
  const resolved = sel.filter(d => d.resolvedAt)
  const tradeCounts = await db.select({ strategy: trades.strategy, n: sql<number>`count(*)::int` }).from(trades).groupBy(trades.strategy)
  return NextResponse.json({
    selectedSymbol: cfg?.symbol,
    confirmationMode: cfg?.confirmationMode,
    model: model ? { sampleCount: model.sampleCount, correctCount: model.correctCount, rollingAccuracy: model.rollingAccuracy, gen: (model.weights as any)?.__gen ?? null } : null,
    classifier: {
      totalOnSelected: sel.length,
      resolved: resolved.length,
      accepted: sel.filter(d => d.finalAllowed).length,
      rejected: sel.filter(d => !d.finalAllowed).length,
      latest: sel[0] ?? null,
    },
    tradesByStrategy: tradeCounts,
  })
}

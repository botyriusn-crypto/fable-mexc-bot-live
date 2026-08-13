import { NextResponse } from "next/server"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { classifierDecisions } from "@/lib/db/schema"
import { getVariants, scoreVariant, recordOutcome } from "@/lib/advisor"
import type { FeatureVector } from "@/lib/indicators"

export const dynamic = "force-dynamic"

async function leaderboard() {
  const variants = await getVariants()
  return variants
    .map(v => ({ name: v.name, params: v.params, stats: v.stats, score: scoreVariant(v.stats) }))
    .sort((a, b) => b.score - a.score)
}

export async function GET() {
  try {
    const variants = await leaderboard()
    return NextResponse.json({ variants, leader: variants[0] ?? null })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, variants: [] }, { status: 500 })
  }
}

// One-time (idempotent) backfill: reset stats, replay every resolved shadow decision
export async function POST() {
  try {
    await db.execute(sql`UPDATE advisor_variants SET stats = '{"allowed":0,"correct":0,"sumReturn":0}'::jsonb`)
    const resolved = await db.select().from(classifierDecisions)
      .where(and(eq(classifierDecisions.strategy, "shadow"), isNotNull(classifierDecisions.resolvedAt)))
    for (const d of resolved) {
      const f = (d.lorentzianFilters ?? null) as any as FeatureVector | null
      if (!f) continue
      await recordOutcome(f, d.candidateDirection, d.logisticConfidence, Boolean(d.outcomeCorrectLogistic), d.outcomeReturn ?? 0)
    }
    const variants = await leaderboard()
    return NextResponse.json({ backfilled: resolved.length, variants, leader: variants[0] ?? null })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 })
  }
}

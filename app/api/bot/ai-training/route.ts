import { NextResponse } from "next/server"
import { desc } from "drizzle-orm"
import { db } from "@/lib/db"
import { aiRecommendations } from "@/lib/db/schema"
import {
  analyzeTradesForMarket,
  applyRecommendations,
  previewRecommendations,
} from "@/lib/ai-advisor"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// GET -> the audit trail: recent stored proposals, newest first. Every
// analyze() call inserts one row (status "pending", even when the caller
// immediately applies), so this is the record of what the model proposed and
// what the guardrails did with it.
export async function GET() {
  try {
    const rows = await db
      .select()
      .from(aiRecommendations)
      .orderBy(desc(aiRecommendations.analysisAt))
      .limit(20)
    return NextResponse.json({ success: true, proposals: rows })
  } catch (err) {
    return NextResponse.json({ success: false, error: msg(err) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 })
  }

  const action = body?.action

  try {
    // ── analyze: build the prompt, call the model, clamp the response ──
    // Everything the panel needs to render the review comes back at once:
    // the raw `recommendations` (what the model asked for) and the `clamped` /
    // `skipped` sets (what the guardrails did with it).
    if (action === "analyze") {
      const symbol = typeof body.symbol === "string" ? body.symbol.trim() : ""
      const timeframe = typeof body.timeframe === "string" && body.timeframe ? body.timeframe : "Min15"
      if (!symbol) {
        return NextResponse.json({ success: false, error: "symbol is required" }, { status: 400 })
      }
      const result = await analyzeTradesForMarket(symbol, timeframe)
      if (!result) {
        return NextResponse.json({ success: false, error: "no bot_config row found" }, { status: 500 })
      }
      return NextResponse.json({ success: true, symbol, timeframe, ...result })
    }

    // ── preview: re-clamp a set and report what would change, writing nothing ──
    // Useful on its own (it shows the effect of the live bounds and the
    // coherence rules) and as a pre-apply check on stored proposals, whose
    // anchors may have moved since they were recorded.
    if (action === "preview") {
      const recs = Array.isArray(body.recommendations) ? body.recommendations : []
      const preview = await previewRecommendations(recs)
      return NextResponse.json({ success: true, ...preview })
    }

    // ── apply: write the clamped values ──
    // autoApply must be EXPLICITLY true. The panel sends it only from the
    // Apply button, so a stray call cannot write parameters by accident.
    if (action === "apply") {
      const recs = Array.isArray(body.recommendations) ? body.recommendations : []
      const recommendationId = Number(body.recommendationId ?? 0)
      const result = await applyRecommendations(recommendationId, recs, {
        autoApply: body.autoApply === true,
      })
      // result.ok is false when nothing was written (autoApply off, all
      // skipped, or an incoherent set) — pass it through rather than masking
      // it as an HTTP failure, since the reason string is the useful part.
      return NextResponse.json({ success: result.ok, ...result })
    }

    return NextResponse.json({ success: false, error: `unknown action "${String(action)}"` }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ success: false, error: msg(err) }, { status: 500 })
  }
}

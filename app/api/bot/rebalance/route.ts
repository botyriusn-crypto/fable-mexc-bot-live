import { NextResponse } from "next/server"
import { computePortfolioRebalance, applyRebalance } from "@/lib/portfolio-sizing"
import { log } from "@/lib/grid"

export const dynamic = "force-dynamic"

// GET: preview only, never writes to the database.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const timeframe = searchParams.get("timeframe") || "Min15"
    const risks = await computePortfolioRebalance(timeframe)
    return NextResponse.json({ preview: true, pairs: risks })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

// POST: actually applies. Requires an explicit { confirm: true } body so this
// can never fire from an accidental click, prefetch, or stray request.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    if (body.confirm !== true) {
      return NextResponse.json({ error: "Pass { confirm: true } to apply. Use GET to preview first." }, { status: 400 })
    }
    const timeframe = body.timeframe || "Min15"
    const risks = await computePortfolioRebalance(timeframe)
    const result = await applyRebalance(risks)
    await log("info", `[Rebalance] Applied to ${result.applied} pair(s), skipped ${result.skipped.length} (${result.skipped.join(", ") || "none"}) for insufficient notional`)
    return NextResponse.json({ applied: result.applied, skipped: result.skipped, pairs: risks })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

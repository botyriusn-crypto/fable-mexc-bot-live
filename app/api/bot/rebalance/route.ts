import { NextResponse } from "next/server"
import { computePortfolioRebalance, applyRebalance } from "@/lib/portfolio-sizing"
import { log } from "@/lib/grid"

export const dynamic = "force-dynamic"

// GET: preview only, never writes to the database.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const timeframe = searchParams.get("timeframe") || "Min15"
    const result = await computePortfolioRebalance(timeframe)
    return NextResponse.json({ preview: true, ...result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

// POST: actually applies. Requires { confirm: true }. If the circuit breaker
// tripped (too much missing candle data), also requires { force: true } to
// override — otherwise it refuses, same as the automatic scheduler would.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    if (body.confirm !== true) {
      return NextResponse.json({ error: "Pass { confirm: true } to apply. Use GET to preview first." }, { status: 400 })
    }
    const timeframe = body.timeframe || "Min15"
    const result = await computePortfolioRebalance(timeframe)
    if (!result.dataQualityOk && body.force !== true) {
      return NextResponse.json({
        error: `Circuit breaker: ${(result.failureRatio * 100).toFixed(0)}% of pairs had candle fetch failures (${result.failedSymbols.join(", ")}). Pass { force: true } to apply anyway.`,
        ...result,
      }, { status: 409 })
    }
    const applyResult = await applyRebalance(result.risks)
    await log("info", `[Rebalance] Manually applied to ${applyResult.applied} pair(s), skipped ${applyResult.skipped.length} (${applyResult.skipped.join(", ") || "none"}) for insufficient notional`)
    return NextResponse.json({ applied: applyResult.applied, skipped: applyResult.skipped, ...result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

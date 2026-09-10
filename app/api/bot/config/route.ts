import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, botLogs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

const NUMERIC_FIELDS = [
  "emaFast",
  "emaSlow",
  "rsiPeriod",
  "rsiOverbought",
  "rsiOversold",
  "atrPeriod",
  "adxTrendThreshold",
  "adxRangeThreshold",
  "bbPeriod",
  "bbStd",
  "slAtrMult",
  "tpAtrMult",
  "trailAtrMult",
  "momentumThreshold",
  "mlConfidenceThreshold",
  "mlLearningRate",
  "lorentzianConfidenceThreshold",
  "lorentzianNeighbors",
  "lorentzianLookback",
  "lorentzianRegimeThreshold",
  "lorentzianAdxThreshold",
  "positionSizeUsdt",
  "gridLevels",
  "gridRangeAtrMult",
  "gridFeeMarginMult",
  "gridBudgetPct",
  "gridLeverage",
] as const

const STRATEGY_MODES = ["auto", "trend", "range"] as const
const CONFIRMATION_MODES = ["observe", "logistic", "lorentzian", "both"] as const
const AI_SCHEDULES = ["manual", "daily", "weekly"] as const
const EXCHANGES = ["mexc", "gate", "bybit"] as const
const BOOL_FIELDS = [
  "allowLong",
  "allowShort",
  "gridAutoPause",
  "lorentzianUseVolatilityFilter",
  "lorentzianUseRegimeFilter",
  "lorentzianUseAdxFilter",
  "lorentzianKernelFilter",
  "lorentzianWebhooks",
  "aiAdvisorEnabled",
] as const

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const updates: Record<string, unknown> = {}

    for (const f of NUMERIC_FIELDS) {
      if (typeof body[f] === "number" && Number.isFinite(body[f])) updates[f] = body[f]
    }
    for (const f of BOOL_FIELDS) {
      if (typeof body[f] === "boolean") updates[f] = body[f]
    }
    if (
      typeof body.strategyMode === "string" &&
      (STRATEGY_MODES as readonly string[]).includes(body.strategyMode)
    ) {
      updates.strategyMode = body.strategyMode
    }
    if (
      typeof body.confirmationMode === "string" &&
      (CONFIRMATION_MODES as readonly string[]).includes(body.confirmationMode)
    ) {
      updates.confirmationMode = body.confirmationMode
    }
    if (
      typeof body.aiAnalysisSchedule === "string" &&
      (AI_SCHEDULES as readonly string[]).includes(body.aiAnalysisSchedule)
    ) {
      updates.aiAnalysisSchedule = body.aiAnalysisSchedule
    }
    if (
      typeof body.exchange === "string" &&
      (EXCHANGES as readonly string[]).includes(body.exchange)
    ) {
      updates.exchange = body.exchange
    }
    if (typeof updates.lorentzianConfidenceThreshold === "number" && (updates.lorentzianConfidenceThreshold < 0 || updates.lorentzianConfidenceThreshold > 1)) {
      return NextResponse.json({ error: "Lorentzian confidence must be between 0 and 1" }, { status: 400 })
    }
    if (typeof updates.lorentzianNeighbors === "number" && (!Number.isInteger(updates.lorentzianNeighbors) || updates.lorentzianNeighbors < 1 || updates.lorentzianNeighbors > 100)) {
      return NextResponse.json({ error: "Lorentzian neighbors must be an integer from 1 to 100" }, { status: 400 })
    }
    if (typeof updates.lorentzianLookback === "number" && (!Number.isInteger(updates.lorentzianLookback) || updates.lorentzianLookback < 80 || updates.lorentzianLookback > 2000)) {
      return NextResponse.json({ error: "Lorentzian lookback must be an integer from 80 to 2000" }, { status: 400 })
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields" }, { status: 400 })
    }

    updates.updatedAt = sql`NOW()`
    await db.update(botConfig).set(updates).where(eq(botConfig.id, 1))
    await db.insert(botLogs).values({
      level: "info",
      message: "Strategy settings updated",
      details: updates as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

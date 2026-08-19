import { db } from "./db"
import { trades, botConfig, aiRecommendations } from "./db/schema"
import { eq, desc, and } from "drizzle-orm"
import { clampRecommendations, normalizeField } from "./ai-levers"

export interface TradeAnalysis {
  tradeCount: number
  avgReturn: number
  winRate: number
  recentTrades: Array<{ side: string; pnl: number; fees: number; exitReason: string }>
}

export interface Recommendation {
  field: string
  current: string | number | boolean
  suggested: string | number | boolean
  reason: string
  impact: string
}

async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY
  const model = process.env.AI_MODEL || "deepseek-chat"
  
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY or ANTHROPIC_API_KEY not set")

  // DeepSeek uses OpenAI-compatible API
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"
  
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.3,
    }),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ""
}

export async function analyzeTradesForMarket(
  symbol: string,
  timeframe: string,
): Promise<{ analysis: TradeAnalysis; recommendations: Recommendation[] } | null> {
  try {
    const recentTrades = await db
      .select()
      .from(trades)
      .where(and(eq(trades.symbol, symbol)))
      .orderBy(desc(trades.closedAt))
      .limit(50)

    if (recentTrades.length < 5) {
      throw new Error(`Need at least 5 closed trades for ${symbol} (found ${recentTrades.length})`)
    }

    const cfg = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
    if (!cfg.length) return null
    const config = cfg[0]

    const totalReturn = recentTrades.reduce((sum, t) => sum + (t.pnl - t.fees), 0)
    const avgReturn = totalReturn / recentTrades.length
    const winCount = recentTrades.filter((t) => t.pnl > t.fees).length
    const winRate = winCount / recentTrades.length

    const analysis: TradeAnalysis = {
      tradeCount: recentTrades.length,
      avgReturn,
      winRate,
      recentTrades: recentTrades.map((t) => ({
        side: t.side, pnl: t.pnl, fees: t.fees, exitReason: t.exitReason,
      })),
    }

    // Fetch market context from CryptoDataAPI (free tier)
  let marketContext = ""
  try {
    const apiKey = process.env.CRYPTODATA_API_KEY
    if (apiKey) {
      const res = await fetch("https://cryptodataapi.com/api/v1/backtesting/daily-snapshots?limit=1", {
        headers: { "X-API-Key": apiKey }
      })
      if (res.ok) {
        const data = await res.json()
        marketContext = data?.length ? `\nMARKET CONTEXT (latest snapshot): ${JSON.stringify(data[0]).slice(0,200)}\n` : ""
      }
    }
  } catch (err) { /* best-effort */ }

  const prompt = `You are a trading strategy advisor. Analyze this trading performance and suggest specific, quantified setting adjustments.

${marketContext}MARKET: ${symbol} / ${timeframe}
Recent Trades: ${recentTrades.length}
Average Return per Trade: ${(avgReturn * 100).toFixed(2)}%
Win Rate: ${(winRate * 100).toFixed(1)}%

CURRENT SETTINGS:
- ML Confidence Threshold: ${config.mlConfidenceThreshold}
- Stop Loss ATR Multiplier: ${config.slAtrMult}
- Take Profit ATR Multiplier: ${config.tpAtrMult}
- EMA Fast: ${config.emaFast} / EMA Slow: ${config.emaSlow}
- RSI Period: ${config.rsiPeriod}
- Strategy Mode: ${config.strategyMode}
- Position Size: $${config.positionSizeUsdt}
- Confirmation Mode: ${config.confirmationMode}

SNIPER SETTINGS:
- Sniper Live: ${config.sniperLive}
- Sniper Max Entries: ${config.sniperMaxEntries}
- Sniper Position Size: $${config.sniperPositionSizeUsdt}
- Sniper Leverage: ${config.sniperLeverage}x
- Sniper Confidence Floor: ${config.sniperConfidenceFloor}
- Sniper Correlation Threshold: ${config.sniperCorrThreshold}
- Sniper Sigma Extreme: ${config.sniperSigmaExtreme}
- Sniper Volume Surge ×: ${config.sniperVolumeSurgeMult}
- Sniper Min Volume (USDT): ${config.sniperMinVolumeUsdt}
- Sniper Target Risk (USDT): $${config.sniperTargetRiskUsdt} (read-only — do not recommend changes)

RECENT TRADE OUTCOMES:
${recentTrades.slice(0, 10).map((t, i) => `Trade ${i + 1}: ${t.side.toUpperCase()} - PnL: $${t.pnl.toFixed(2)}, Fees: $${t.fees.toFixed(2)}, Exit: ${t.exitReason}`).join("\n")}

Provide 2-4 specific, actionable recommendations to improve performance. Return as JSON array. Use EXACTLY these field names (camelCase, no spaces):
- mlConfidenceThreshold
- slAtrMult
- tpAtrMult
- emaFast
- emaSlow
- rsiPeriod
- momentumThreshold
- positionSizeUsdt
- sniperMaxEntries
- sniperPositionSizeUsdt
- sniperLeverage
- sniperConfidenceFloor
- sniperCorrThreshold
- sniperSigmaExtreme
- sniperVolumeSurgeMult
- sniperMinVolumeUsdt

[
  {"field": "mlConfidenceThreshold", "current": 0.7, "suggested": 0.85, "reason": "brief reason", "impact": "expected impact"}
]`

    const text = await callLLM(prompt)
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    const recommendations: Recommendation[] = jsonMatch ? JSON.parse(jsonMatch[0]) : []

    // Store analysis
    await db.insert(aiRecommendations).values({
      symbol, timeframe,
      tradeCount: analysis.tradeCount,
      avgReturn: analysis.avgReturn,
      winRate: analysis.winRate,
      currentSettings: {
        mlConfidenceThreshold: config.mlConfidenceThreshold,
        slAtrMult: config.slAtrMult,
        tpAtrMult: config.tpAtrMult,
        emaFast: config.emaFast, emaSlow: config.emaSlow,
        strategyMode: config.strategyMode,
        sniperMaxEntries: config.sniperMaxEntries,
        sniperPositionSizeUsdt: config.sniperPositionSizeUsdt,
        sniperLeverage: config.sniperLeverage,
        sniperConfidenceFloor: config.sniperConfidenceFloor,
        sniperCorrThreshold: config.sniperCorrThreshold,
        sniperSigmaExtreme: config.sniperSigmaExtreme,
        sniperVolumeSurgeMult: config.sniperVolumeSurgeMult,
        sniperMinVolumeUsdt: config.sniperMinVolumeUsdt,
        sniperTargetRiskUsdt: config.sniperTargetRiskUsdt,
      },
      recommendations,
      status: "pending",
    })

    return { analysis, recommendations }
  } catch (error) {
    console.error("[AI Advisor] error:", error)
    const msg = error instanceof Error ? error.message : "Unknown error"
    throw new Error(`Analysis failed: ${msg}`)
  }
}

export async function applyRecommendations(
  recommendationId: number,
  recommendations: Array<{ field: string; current: unknown; suggested: unknown; reason: string; impact: string }>,
): Promise<boolean> {
  try {
    // Normalize display names ("ML Confidence Threshold") to canonical keys
    // ("mlConfidenceThreshold") before routing through the levers.
    const normalized = recommendations.map((rec) => ({ ...rec, field: normalizeField(rec.field) }))

    // Route every suggestion through the levers (guardrails) before writing.
    const { applied, skipped } = clampRecommendations(
      normalized as Array<{ field: string; current: string | number | boolean; suggested: string | number | boolean; reason: string; impact: string }>,
    )

    for (const rec of skipped) {
      console.warn(`[AI Advisor] Skipped ${rec.field}: ${rec.skipReason}`)
    }
    for (const rec of applied) {
      if (rec.wasClamped) {
        console.warn(`[AI Advisor] Clamped ${rec.field}: ${rec.current} -> ${rec.suggested} -> ${rec.clamped}`)
      }
    }

    const updates: Record<string, unknown> = {}
    for (const rec of applied) {
      updates[rec.field] = rec.clamped
    }
    if (Object.keys(updates).length === 0) return false

    await db.update(botConfig).set({ ...updates, updatedAt: new Date() }).where(eq(botConfig.id, 1))
    await db.update(aiRecommendations).set({ status: "applied", appliedAt: new Date() }).where(eq(aiRecommendations.id, recommendationId))
    return true
  } catch (error) {
    console.error("[Apply recommendations] error:", error)
    return false
  }
}

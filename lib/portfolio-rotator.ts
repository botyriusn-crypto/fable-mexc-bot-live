import { db } from "./db"
import { gridConfigs, gridOrders, trades, botConfig } from "./db/schema"
import { eq, and, sql } from "drizzle-orm"
import { log } from "./logger"
import { recordGridOutcome } from "./ai-grid-advisor"

const ROTATION_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const MIN_AGE_HOURS = 6 // Don't kill grids younger than 6h
const MAX_REPLACEMENTS_PER_CYCLE = 3
const MAX_DEPLOYED_PCT = 90 // Safety cap: never deploy more than 90% of balance // Cap to prevent over-trading

let lastRotationTime = 0
let rotationEnabled = true

export function isRotationEnabled(): boolean {
  return rotationEnabled
}

export function setRotationEnabled(enabled: boolean) {
  rotationEnabled = enabled
}

export function getLastRotationTime(): number {
  return lastRotationTime
}

export async function checkAndRotate(exchange: any): Promise<void> {
  if (!rotationEnabled) return

  // Master kill-switch: never rotate while grids are stopped. Rotation creates
  // new enabled grids, which would defeat a STOP.
  const cfgRows = await db.select({ gridEnabled: botConfig.gridEnabled }).from(botConfig).where(eq(botConfig.id, 1))
  if (!cfgRows[0]?.gridEnabled) return

  const now = Date.now()
  if (now - lastRotationTime < ROTATION_INTERVAL_MS) return

  try {
    await log("info", "🔄 Portfolio Rotation: Starting 4-hour audit...")

    // 1. Get all active COMBO (neutral) grids
    const allConfigs = await db.select().from(gridConfigs)
    const comboConfigs = allConfigs.filter(c =>
      c.direction === "neutral" && c.enabled && !c.paused
    )

    if (comboConfigs.length === 0) {
      await log("info", "No active COMBO grids to audit")
      return
    }

    // 2. Compute age and PnL for each
    const allTrades = await db.select().from(trades)
    const tradesBySymbol = allTrades.reduce((acc, t) => {
      if (!acc[t.symbol]) acc[t.symbol] = []
      acc[t.symbol].push(t)
      return acc
    }, {} as Record<string, any[]>)

    const audits = comboConfigs.map(c => {
      const age = c.createdAt ? (now - new Date(c.createdAt).getTime()) / (1000 * 60 * 60) : 0
      const symbolTrades = tradesBySymbol[c.symbol] || []
      const pnl = symbolTrades.reduce((sum, t) => sum + parseFloat(t.pnl), 0)
      return { config: c, ageHours: age, pnl }
    })

    // 3. Identify "dead" grids (old enough + no PnL)
    const dead = audits.filter(a => a.ageHours >= MIN_AGE_HOURS && a.pnl <= 0)
    const alive = audits.filter(a => a.pnl > 0)

    await log("info", `Portfolio audit: ${alive.length} alive, ${dead.length} dead. Active COMBO grids: ${comboConfigs.length}. Needs >${MIN_AGE_HOURS}h age with <=$0 PnL to be dead.`)

    if (dead.length === 0) {
      await log("info", `No dead grids found (${alive.length} alive, ${dead.length} dead). Rotation needs grids >6h old with <=$0 PnL.`)
      await log("info", "✅ All grids performing - no rotation needed")
      lastRotationTime = now
      return
    }

    // 4. Get AI Advisor recommendations
    await log("info", "🔍 Scanning for fresh AI Advisor picks...")
    const aiRes = await fetch("https://fable-mexc-bot.fly.dev/api/bot/ai-advisor")
    if (!aiRes.ok) {
      await log("error", "AI Advisor scan failed - skipping rotation")
      return
    }
    const aiData = await aiRes.json()
    const candidates = aiData.recommendations || []

    if (candidates.length === 0) {
      await log("info", "AI Advisor returned no candidates - skipping rotation")
      return
    }

    // 5. Perform replacements
    const existingSymbols = new Set(comboConfigs.map(c => c.symbol))
    const totalDeployed = allConfigs.filter(c => c.enabled).reduce((s, c) => s + (c.budgetPct || 0), 0)
    let replaced = 0

    for (const deadGrid of dead) {
      if (replaced >= MAX_REPLACEMENTS_PER_CYCLE) {
        await log("info", `Rotation cap reached (${MAX_REPLACEMENTS_PER_CYCLE}) - stopping`)
        break
      }

      // Find first candidate not already in portfolio
      const candidate = candidates.find((c: any) => !existingSymbols.has(c.symbol))
      if (!candidate) {
        await log("info", "No more new candidates available - stopping rotation")
        break
      }

      // Budget safety: stop if adding would exceed cap
      const newBudget = candidate.budgetPct || 10
      if (totalDeployed + newBudget > MAX_DEPLOYED_PCT) {
        await log("info", `Budget cap reached (${totalDeployed}% deployed) - stopping rotation`)
        break
      }

      try {
        await log("trade", `🔄 Rotating: ${deadGrid.config.symbol} (${deadGrid.ageHours.toFixed(1)}h old, $${deadGrid.pnl} PnL) → ${candidate.symbol}`)

        // 1.1 Feedback loop: record this dead grid's outcome so the AI advisor
        // won't re-pick a symbol that just lost money (48h cool-off).
        recordGridOutcome(deadGrid.config.symbol, deadGrid.pnl)

        // Pause old grid
        await db.update(gridConfigs)
          .set({ enabled: false, paused: true })
          .where(eq(gridConfigs.id, deadGrid.config.id))

        // Delete old ladder
        await db.delete(gridOrders)
          .where(and(
            eq(gridOrders.symbol, deadGrid.config.symbol),
            eq(gridOrders.timeframe, deadGrid.config.timeframe)
          ))

        // Create new grid config
        await db.insert(gridConfigs).values({
          symbol: candidate.symbol,
          timeframe: "Min15",
          direction: "neutral",
          levels: candidate.levels || 10,
          rangeAtrMult: 1.0,
          leverage: candidate.leverage || 5,
          budgetPct: 10,
          autoPause: false,
          enabled: true,
          makerMode: true,
          paused: false,
          metadata: {
            rotatedFrom: deadGrid.config.symbol,
            rotatedAt: now,
            aiScore: candidate.dnaScore,
            suggestedSpacing: candidate.suggestedSpacingPct
          }
        })

        await log("trade", `✅ Created new COMBO grid: ${candidate.symbol} (DNA: ${candidate.dnaScore}, x${candidate.leverage})`)

        existingSymbols.add(candidate.symbol)
        replaced++
      } catch (err) {
        await log("error", `Failed to rotate ${deadGrid.config.symbol}: ${err}`)
      }
    }

    await log("info", `🎯 Rotation complete: ${replaced} grids replaced`)
    lastRotationTime = now

  } catch (err) {
    await log("error", `Rotation error: ${err}`)
  }
}

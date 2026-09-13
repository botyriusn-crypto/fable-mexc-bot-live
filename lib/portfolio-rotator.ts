import { db } from "./db"
import { gridConfigs, gridOrders, trades, botConfig } from "./db/schema"
import { eq, and, isNull } from "drizzle-orm"
import { log } from "./logger"
import { recordGridOutcome } from "./ai-grid-advisor"
import { VALIDATED_SYMBOLS } from "./validated-symbols"

const ROTATION_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const MIN_AGE_HOURS = 6 // Don't kill grids younger than 6h
const MAX_REPLACEMENTS_PER_CYCLE = 3
const MAX_DEPLOYED_PCT = 90 // Safety cap: never deploy more than 90% of balance // Cap to prevent over-trading

// URL of the AI advisor endpoint on THIS deployment. Defaults to the current
// Fly app but is env-overridable so a rename/fork/preview deploy does not
// silently break rotation (the fetch failing means rotation is skipped every
// cycle, which is invisible in the UI).
const AI_ADVISOR_URL =
  process.env.AI_ADVISOR_URL ?? "https://fable-mexc-bot.fly.dev/api/bot/ai-advisor"

// Advisor fetch must never stall the tick that calls rotation. 30s is well
// within the 60s tick budget and gives the advisor (which scans 100 markets
// and does a depth check) room to finish.
const AI_ADVISOR_TIMEOUT_MS = 30_000

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
  const cfgRows = await db
    .select({ gridEnabled: botConfig.gridEnabled, mode: botConfig.mode })
    .from(botConfig)
    .where(eq(botConfig.id, 1))
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

    // 2. Compute age and PnL for each.
    //
    // PnL is filtered BY MODE. Rotating on a figure that is the sum of live +
    // paper trades misclassifies a live winner as dead (or vice versa) — a
    // grid can be "profitable" on the paper book and deeply down live and get
    // rotated in, or the reverse. The mode comes from bot_config, same as the
    // trades rows themselves.
    const modeIsLive = cfgRows[0]?.mode === "live"
    const allTrades = await db.select().from(trades).where(eq(trades.live, modeIsLive))
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
    // Bounded fetch: an unresponsive advisor must not stall the tick that
    // called rotation.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), AI_ADVISOR_TIMEOUT_MS)
    let aiRes: Response
    try {
      aiRes = await fetch(AI_ADVISOR_URL, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (!aiRes.ok) {
      await log("error", `AI Advisor scan failed (${aiRes.status}) - skipping rotation`)
      return
    }
    const aiData = await aiRes.json()
    const candidates = (aiData.recommendations || []).filter((c: any) => VALIDATED_SYMBOLS.has(c.symbol))

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

        // Delete the old LADDER, but only the UNFILLED rungs.
        //
        // Rows with buyPrice set represent real held inventory — a filled buy
        // awaiting its sell, or a filled short awaiting its buy-to-close — that
        // is still OPEN on the exchange. Deleting those rows loses the tracking
        // record, orphaning the real position (the orphan sweep then force-
        // closes it at market WITHOUT booking a trade, so the PnL vanishes from
        // the books). Leave them: the grid's own risk path (checkGridStopLoss /
        // checkAllHeldPositionsRisk) keeps closing held inventory even after the
        // config is disabled, and the recenter paths are now gc.enabled-guarded
        // so they will not rebuild a fresh ladder for this pair.
        await db.delete(gridOrders)
          .where(and(
            eq(gridOrders.symbol, deadGrid.config.symbol),
            eq(gridOrders.timeframe, deadGrid.config.timeframe),
            isNull(gridOrders.buyPrice),
          ))

        // ── Reuse the existing row for the candidate if one exists ──
        //
        // Previously this always INSERTed a new grid_configs row. Rotating a
        // symbol out and later back in left two rows for the same symbol.
        // Those duplicate rows then made the tick loop manage the pair twice,
        // and made the state API's gridRealizedRows aggregation (join on
        // symbol) fan out trades by the number of matching config rows,
        // multiplying SUM(pnl). Rows are now reused: enable + reconfigure the
        // existing disabled row for the candidate symbol if there is one,
        // otherwise insert a fresh one.
        const existingCandidate = allConfigs.find(c => c.symbol === candidate.symbol)
        const configFields = {
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
            suggestedSpacing: candidate.suggestedSpacingPct,
          },
        }
        if (existingCandidate) {
          await db.update(gridConfigs)
            .set({ ...configFields, updatedAt: new Date() })
            .where(eq(gridConfigs.id, existingCandidate.id))
          await log("trade", `♻️ Re-enabled existing grid config for ${candidate.symbol} (id=${existingCandidate.id})`)
        } else {
          await db.insert(gridConfigs).values({ symbol: candidate.symbol, ...configFields })
        }

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

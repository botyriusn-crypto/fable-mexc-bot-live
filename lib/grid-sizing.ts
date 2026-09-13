import { getExchangeClient, type Exchange } from "./exchange"
import { db } from "./db"
import { gridConfigs, equitySnapshots, botConfig } from "./db/schema"
import { eq, desc } from "drizzle-orm"
import { EXPOSURE_LIMITS } from "./exposure"

export interface SafeGridSettings {
  levels: number
  rangeAtrMult: number
  budgetPct: number
  leverage: number
}

// COMBO/neutral grids build a buy ladder AND a sell ladder simultaneously.
// In setupGrid, margin per order = budget/totalLevels (leverage cancels out
// of the notional formula — it scales position size, not margin used). So
// building both ladders at full size commits more real margin per pair than
// the plain `budget` figure implies, and every budgetPct must be sized with
// that multiplier in mind.
//
// NOTE: the value here is 1.5. lib/portfolio-sizing.ts declares the same-named
// constant as 2 while chasing the same margin envelope, so the two sizers
// disagree by ~33% on the same account. Left as-is deliberately — changing
// either one changes live sizing — but they should be reconciled.
const COMBO_MARGIN_MULTIPLIER = 1.5

// Never let all enabled pairs collectively plan to use more than this
// fraction of available margin. Leaves headroom for price movement,
// unrealized drawdown on filled legs, and fees — margin usage that isn't
// visible until orders actually fill.
const SAFETY_FACTOR = 0.7

// Floors/ceilings so no single pair gets sized into dust or eats the whole
// account, regardless of how many pairs happen to be enabled.
const MIN_BUDGET_PCT = 3
const MAX_BUDGET_PCT = 35

// Must match MIN_NOTIONAL in lib/grid.ts's setupGrid backoff condition.
const MIN_NOTIONAL = 1.0

/**
 * Computes a budgetPct/levels/leverage combination that a real account
 * balance can actually support, given how many pairs are (or will be)
 * running a COMBO grid at once.
 *
 * @param additionalPairs how many NEW pairs are being sized right now
 *   (1 for a single Add Pair / single AI pick, N for applying N AI picks
 *   at once, so they don't each independently claim a "safe" budgetPct
 *   that's only safe in isolation).
 * @param excludeSymbol if resizing an existing pair, exclude it from the
 *   enabled-pair count so it isn't double counted against itself.
 */
export async function computeSafeGridSettings(
  additionalPairs = 1,
  excludeSymbol?: string,
): Promise<SafeGridSettings & { availableBalance: number; totalPairs: number }> {
  // Get current mode from bot_config to decide balance source
  let mode = "paper"
  let exchange: Exchange = "mexc"
  let availableBalance = 0
  try {
    const cfgRows = await db.select().from(botConfig).limit(1)
    if (cfgRows.length > 0) {
      mode = cfgRows[0].mode
      exchange = (cfgRows[0].exchange as Exchange) ?? "mexc"
    }
  } catch {}

  if (mode === "paper") {
    // Paper mode: use the latest PAPER equity snapshot (updated every tick with
    // unrealized PnL).
    //
    // BUG FIXED: this query used to be `orderBy(desc(createdAt)).limit(1)` with
    // no mode filter, so a live snapshot written more recently than the last
    // paper one — which is the normal state of affairs right after a mode
    // switch — was used to size PAPER grids, and vice versa. The dashboard's
    // equity curve already filters on `live`, and so must the sizer.
    try {
      const snapshots = await db
        .select({ equity: equitySnapshots.equity })
        .from(equitySnapshots)
        .where(eq(equitySnapshots.live, false))
        .orderBy(desc(equitySnapshots.createdAt))
        .limit(1)

      if (snapshots.length > 0) {
        availableBalance = Number(snapshots[0].equity || 0)
      } else {
        // Fallback to bot_config.paperBalance if no paper snapshots yet
        const cfgRows = await db.select({ paperBalance: botConfig.paperBalance }).from(botConfig).limit(1)
        availableBalance = cfgRows.length > 0 ? Number(cfgRows[0].paperBalance || 0) : 0
      }
    } catch (e) {
      console.error(`[Grid Sizing] Paper mode: error reading equity snapshot: ${e instanceof Error ? e.message : String(e)}`)
      availableBalance = 0
    }
  } else {
    // Live mode: fetch from the exchange
    try {
      const assets = await getExchangeClient(exchange).getAccountAssets()
      const usdt = assets.find((a) => a.currency === "USDT") ?? null
      availableBalance = usdt ? Number(usdt.availableBalance) : 0
    } catch (e) {
      availableBalance = 0
      console.error(`[Grid Sizing] Live mode: balance fetch failed, availableBalance=0`)
    }
  }

  const enabledRows = await db.select({ symbol: gridConfigs.symbol }).from(gridConfigs).where(eq(gridConfigs.enabled, true))
  const enabledCount = excludeSymbol ? enabledRows.filter((r) => r.symbol !== excludeSymbol).length : enabledRows.length
  const totalPairs = Math.max(1, enabledCount + additionalPairs)

  // Slightly higher leverage on small accounts keeps position sizes
  // meaningful without changing margin usage (margin is budget-driven, not
  // leverage-driven, in this codebase's grid math) — still bounded well
  // under the liquidation-safety check already enforced in lib/grid.ts.
  const leverage = availableBalance < 100 ? 5 : 3

  // Small accounts: fewer, larger orders clear MEXC's per-order minimums
  // more reliably than many tiny slivers.
  const levels = availableBalance < 100 ? 4 : availableBalance < 500 ? 6 : 10

  // Evenly split the safe margin budget across every pair that will be
  // competing for it, then account for the safety buffer per pair.
  let budgetPct = (SAFETY_FACTOR * 100) / (COMBO_MARGIN_MULTIPLIER * totalPairs)

  // MINIMUM-NOTIONAL FLOOR: a budgetPct that can't place even ONE order at
  // MEXC's minimum notional is useless — it produces "budget too small"
  // backoffs despite free balance. Raise the floor to the smallest % that
  // clears the minimum, so no pair is ever sized into dust.
  //   availableBalance * budgetPct/100 * leverage / levels >= MIN_NOTIONAL
  //   budgetPct >= MIN_NOTIONAL * levels * 100 / (availableBalance * leverage)
  // grid.ts's own backoff is on `budget * leverage < MIN_NOTIONAL * sidesPerLevel`
  // (leverage DOES reduce the margin needed), so the buffer below uses
  // COMBO_MARGIN_MULTIPLIER in place of `levels` to stay on the conservative
  // side of both formulations.
  const minBudgetPctForNotional = availableBalance > 0
    ? (MIN_NOTIONAL * COMBO_MARGIN_MULTIPLIER * 100) / (availableBalance * leverage)
    : MIN_BUDGET_PCT
  budgetPct = Math.max(minBudgetPctForNotional, Math.min(MAX_BUDGET_PCT, budgetPct))

  // EXPOSURE-CAP CLAMP: the entry gate (lib/exposure.ts) measures GROSS
  // notional = budgetPct x leverage and blocks entries when it exceeds the
  // per-symbol gross cap. The margin math above never checks this, so a budget
  // that is fine on margin can still self-block on exposure (e.g. 11.7% x 3x =
  // 35.1% > 35%). Clamp so budgetPct x leverage stays under the cap with a
  // safety margin before rounding.
  //
  // Read the limit from lib/exposure.ts rather than re-declaring it: it is
  // env-overridable (MAX_GROSS_EXPOSURE_PCT), and a hardcoded copy here means
  // the sizer silently ignores an override the gate honours.
  const maxBudgetPctForExposure = (EXPOSURE_LIMITS.maxGrossNotionalPctOfEquity() * 100) / leverage
  budgetPct = Math.min(budgetPct, maxBudgetPctForExposure - 0.5)

  // RE-APPLY THE NOTIONAL FLOOR. The exposure clamp above can push budgetPct
  // BELOW the minimum that funds even one order — at small balances the two
  // constraints genuinely conflict (e.g. $3 balance at 5x: floor 10%, exposure
  // cap 6.5%). Left as the clamp produced it, the pair was sized into dust and
  // hit grid.ts's 30-minute "budget too small" backoff while the account showed
  // free balance. The floor wins: if the two really cannot both hold, the
  // exposure gate will refuse the entry for this pair, which is the honest
  // outcome and is visible in the logs.
  budgetPct = Math.max(budgetPct, minBudgetPctForNotional)

  budgetPct = Math.round(budgetPct * 10) / 10

  return {
    levels,
    rangeAtrMult: 1.5,
    budgetPct,
    leverage,
    availableBalance,
    totalPairs,
  }
}

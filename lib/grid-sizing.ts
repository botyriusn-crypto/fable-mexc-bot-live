import { getAccountAssets } from "./mexc/private"
import { db } from "./db"
import { gridConfigs } from "./db/schema"
import { eq } from "drizzle-orm"

export interface SafeGridSettings {
  levels: number
  rangeAtrMult: number
  budgetPct: number
  leverage: number
}

// COMBO/neutral grids build a buy ladder AND a sell ladder simultaneously.
// In setupGrid, margin per order = budget/totalLevels (leverage cancels out
// of the notional formula — it scales position size, not margin used). So
// building both ladders at full size commits roughly 2x `budget` in real
// margin per pair, not 1x. Every budgetPct must be sized with this in mind.
const COMBO_MARGIN_MULTIPLIER = 2

// Never let all enabled pairs collectively plan to use more than this
// fraction of available margin. Leaves headroom for price movement,
// unrealized drawdown on filled legs, and fees — margin usage that isn't
// visible until orders actually fill.
const SAFETY_FACTOR = 0.7

// Floors/ceilings so no single pair gets sized into dust or eats the whole
// account, regardless of how many pairs happen to be enabled.
const MIN_BUDGET_PCT = 3
const MAX_BUDGET_PCT = 35

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
  let availableBalance = 0
  try {
    const assets = (await getAccountAssets()) as any[]
    const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
    availableBalance = usdt ? Number(usdt.availableBalance) : 0
  } catch {
    availableBalance = 0
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
  // competing for it, then account for COMBO needing 2x per pair.
  let budgetPct = (SAFETY_FACTOR * 100) / (COMBO_MARGIN_MULTIPLIER * totalPairs)

  // MINIMUM-NOTIONAL FLOOR: a budgetPct that can't place even ONE order at
  // MEXC's minimum notional is useless — it produces "budget too small"
  // backoffs despite free balance. Raise the floor to the smallest % that
  // clears the minimum, so no pair is ever sized into dust.
  //   notional per order = budget * leverage / totalLevels (see setupGrid)
  //   availableBalance * budgetPct/100 * leverage / levels >= MIN_NOTIONAL
  //   budgetPct >= MIN_NOTIONAL * levels * 100 / (availableBalance * leverage)
  const MIN_NOTIONAL = 1.0
  const minBudgetPctForNotional = availableBalance > 0
    ? (MIN_NOTIONAL * levels * 100) / (availableBalance * leverage)
    : MIN_BUDGET_PCT
  budgetPct = Math.max(minBudgetPctForNotional, Math.min(MAX_BUDGET_PCT, budgetPct))
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

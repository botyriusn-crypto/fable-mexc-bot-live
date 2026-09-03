import { db } from "./db"
import { gridConfigs, botConfig } from "./db/schema"
import { eq } from "drizzle-orm"
import { getExchangeClient, type Exchange } from "./exchange"
import type { Candle } from "./mexc/public"
import { log } from "./grid"

// ---- Portfolio-level sizing: volatility-inverse + correlation-aware ----
// Replaces flat-equal-split budgetPct across enabled pairs with weights that
// account for (a) how volatile/risky each pair is on its own, and (b) how
// much of that risk is *shared* with the rest of the portfolio (correlation).
// Total portfolio risk budget is kept the same as the existing flat-split
// design (SAFETY_FACTOR / COMBO_MARGIN_MULTIPLIER) — this only changes HOW
// that fixed total gets divided among pairs, not how much total risk is taken.

const SAFETY_FACTOR = 0.7
const COMBO_MARGIN_MULTIPLIER = 2
const MIN_BUDGET_PCT = 3
const MAX_BUDGET_PCT = 35
const MIN_NOTIONAL = 1.0 // must match grid.ts's MIN_NOTIONAL

// How strongly correlation shrinks a pair's weight. 0 = ignore correlation
// entirely (pure volatility-inverse). Higher = more aggressive de-weighting
// of pairs that move together.
const CORRELATION_PENALTY_FACTOR = 1.5

// Floor volatility so a near-zero-movement pair doesn't get a divide-by-zero
// / absurdly huge weight — it still gets favored, just not infinitely.
const MIN_VOLATILITY = 0.001 // 0.1% — a very quiet pair

// Dampening: no pair's budget can move more than this many percentage
// points in a single rebalance run, regardless of what the raw math says.
// Prevents one noisy volatility window from causing a large sudden swing.
const MAX_DELTA_PCT_PER_RUN = 3

// Circuit breaker: if candle fetches fail for more than this fraction of
// enabled pairs, the run computes (for visibility) but does NOT auto-apply —
// we don't want to reallocate real budget based on degraded data.
const CIRCUIT_BREAKER_FAILURE_RATIO = 0.2

export interface PairRisk {
  symbol: string
  timeframe: string
  volatility: number       // stddev of candle-to-candle % returns
  avgCorrelation: number   // average |correlation| to every other enabled pair
  rawWeight: number        // 1 / volatility
  adjustedWeight: number   // rawWeight / (1 + avgCorrelation * penalty)
  proposedBudgetPct: number // after dampening + min/max clamp
  currentBudgetPct: number
  viable: boolean          // false if proposed allocation can't clear MIN_NOTIONAL
  reason?: string
  dataOk: boolean          // false if this pair's candle fetch failed
}

export interface RebalanceResult {
  risks: PairRisk[]
  failedSymbols: string[]
  failureRatio: number
  dataQualityOk: boolean   // false if failureRatio exceeds the circuit breaker threshold
}

function pctReturns(candles: Candle[]): number[] {
  const out: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close
    const cur = candles[i].close
    if (prev > 0) out.push((cur - prev) / prev)
  }
  return out
}

function stddev(values: number[]): number {
  if (values.length < 2) return MIN_VOLATILITY
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.max(Math.sqrt(variance), MIN_VOLATILITY)
}

// Pearson correlation between two return series. Series come from fetching
// the same interval/limit for every pair in the same call — not perfectly
// candle-for-candle synced across symbols with gaps, but close enough for a
// risk-weighting signal, not a precision requirement.
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  const av = a.slice(0, n)
  const bv = b.slice(0, n)
  const meanA = av.reduce((x, y) => x + y, 0) / n
  const meanB = bv.reduce((x, y) => x + y, 0) / n
  let cov = 0, varA = 0, varB = 0
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA
    const db_ = bv[i] - meanB
    cov += da * db_
    varA += da * da
    varB += db_ * db_
  }
  if (varA === 0 || varB === 0) return 0
  return cov / Math.sqrt(varA * varB)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Compute volatility-inverse, correlation-shrunk, dampened budget weights
 * for all currently enabled grid pairs. Does NOT write to the database —
 * call applyRebalance() or autoRebalance() separately.
 */
export async function computePortfolioRebalance(timeframe = "Min15"): Promise<RebalanceResult> {
  const enabled = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
  if (enabled.length === 0) return { risks: [], failedSymbols: [], failureRatio: 0, dataQualityOk: true }

  let exchange: Exchange = "mexc"
  try {
    const cfgRows = await db.select().from(botConfig).limit(1)
    if (cfgRows.length > 0) exchange = (cfgRows[0].exchange as Exchange) ?? "mexc"
  } catch {}

  let availableBalance = 0
  try {
    const assets = await getExchangeClient(exchange).getAccountAssets()
    const usdt = assets.find((a) => a.currency === "USDT") ?? null
    availableBalance = usdt ? Number(usdt.availableBalance) : 0
  } catch {
    availableBalance = 0
  }

  // Fetch candles for every enabled pair in parallel. A single symbol's
  // fetch failing shouldn't take down the whole rebalance — it falls back to
  // a penalized (higher, not lower) assumed volatility and gets flagged.
  const candleResults = await Promise.all(
    enabled.map(async (gc) => {
      try {
        const candles = await getExchangeClient(exchange).fetchKlines(gc.symbol, timeframe, 100)
        return { symbol: gc.symbol, candles, ok: true as const }
      } catch (err) {
        return { symbol: gc.symbol, candles: [] as Candle[], ok: false as const }
      }
    })
  )

  const failedSymbols = candleResults.filter((r) => !r.ok).map((r) => r.symbol)
  const failureRatio = failedSymbols.length / enabled.length
  const dataQualityOk = failureRatio <= CIRCUIT_BREAKER_FAILURE_RATIO

  const returnsBySymbol = new Map<string, number[]>()
  const okBySymbol = new Map<string, boolean>()
  for (const r of candleResults) {
    returnsBySymbol.set(r.symbol, r.ok ? pctReturns(r.candles) : [])
    okBySymbol.set(r.symbol, r.ok)
  }

  const volBySymbol = new Map<string, number>()
  for (const gc of enabled) {
    const returns = returnsBySymbol.get(gc.symbol) ?? []
    // Unknown/thin data gets penalized with a HIGHER assumed volatility
    // (smaller weight), never a lower one — err toward caution, not exposure.
    volBySymbol.set(gc.symbol, returns.length >= 5 ? stddev(returns) : MIN_VOLATILITY * 5)
  }

  const totalBudgetCap = (SAFETY_FACTOR * 100) / COMBO_MARGIN_MULTIPLIER // same total risk envelope as before

  const risks: PairRisk[] = enabled.map((gc) => {
    const myReturns = returnsBySymbol.get(gc.symbol) ?? []
    const others = enabled.filter((o) => o.symbol !== gc.symbol)
    const correlations = others
      .map((o) => correlation(myReturns, returnsBySymbol.get(o.symbol) ?? []))
      .filter((c) => Number.isFinite(c))
    const avgCorrelation = correlations.length > 0
      ? correlations.reduce((a, b) => a + Math.abs(b), 0) / correlations.length
      : 0

    const volatility = volBySymbol.get(gc.symbol) ?? MIN_VOLATILITY
    const rawWeight = 1 / volatility
    const adjustedWeight = rawWeight / (1 + avgCorrelation * CORRELATION_PENALTY_FACTOR)

    return {
      symbol: gc.symbol,
      timeframe: gc.timeframe,
      volatility,
      avgCorrelation,
      rawWeight,
      adjustedWeight,
      proposedBudgetPct: 0, // filled in after normalization below
      currentBudgetPct: gc.budgetPct,
      viable: true,
      dataOk: okBySymbol.get(gc.symbol) ?? false,
    }
  })

  const totalAdjustedWeight = risks.reduce((a, r) => a + r.adjustedWeight, 0)

  for (const r of risks) {
    let target = totalAdjustedWeight > 0
      ? (r.adjustedWeight / totalAdjustedWeight) * totalBudgetCap
      : totalBudgetCap / risks.length

    // Dampen: clamp the move to +/- MAX_DELTA_PCT_PER_RUN from where it is now.
    // Sanitize the anchor first: a corrupted currentBudgetPct (e.g. a dollar
    // amount like 6387.7 stored in a percent field) must not anchor the
    // dampening window, or the rebalancer can never pull it back down.
    const saneCurrent = Number.isFinite(r.currentBudgetPct) && r.currentBudgetPct > 0 && r.currentBudgetPct <= MAX_BUDGET_PCT
      ? r.currentBudgetPct
      : MAX_BUDGET_PCT
    const dampedLo = saneCurrent - MAX_DELTA_PCT_PER_RUN
    const dampedHi = saneCurrent + MAX_DELTA_PCT_PER_RUN
    target = clamp(target, dampedLo, dampedHi)

    const gc = enabled.find((g) => g.symbol === r.symbol)!
    const sidesPerLevel = gc.direction === "neutral" ? 2 : 1
    const levels = Math.max(1, Math.min(4, Math.floor(gc.levels / 2)))

    // MINIMUM-NOTIONAL FLOOR: a budgetPct that can't place even ONE order per
    // side at MEXC's minimum notional is useless — it produces "budget too
    // small" backoffs despite free balance. Raise the floor to the smallest %
    // that clears the minimum, so no pair is ever sized into dust.
    //   budget * leverage / (levels * sidesPerLevel) >= MIN_NOTIONAL
    //   availableBalance * budgetPct/100 * leverage >= MIN_NOTIONAL * levels * sidesPerLevel
    //   budgetPct >= MIN_NOTIONAL * levels * sidesPerLevel * 100 / (availableBalance * leverage)
    const minBudgetPctForNotional = availableBalance > 0
      ? (MIN_NOTIONAL * sidesPerLevel * 100) / availableBalance
      : MIN_BUDGET_PCT

    // Then apply the absolute floor/ceiling (floor is now notional-aware).
    target = clamp(target, minBudgetPctForNotional, MAX_BUDGET_PCT)
    r.proposedBudgetPct = Math.round(target * 10) / 10

    const budget = (availableBalance * r.proposedBudgetPct) / 100
    const notionalPerLevel = (budget * gc.leverage) / (levels * sidesPerLevel)
    if (notionalPerLevel < MIN_NOTIONAL) {
      r.viable = false
      r.reason = `Proposed budget ${r.proposedBudgetPct}% -> $${budget.toFixed(2)} can't clear $${MIN_NOTIONAL} minimum notional per order at ${levels} levels/side. Consider disabling this pair or consolidating capital into fewer pairs.`
    }
  }

  return { risks, failedSymbols, failureRatio, dataQualityOk }
}

/**
 * Actually writes the proposed budgetPct to every viable, data-ok pair.
 * Call computePortfolioRebalance() first and review the output.
 */
export async function applyRebalance(risks: PairRisk[]): Promise<{ applied: number; skipped: string[] }> {
  let applied = 0
  const skipped: string[] = []
  for (const r of risks) {
    if (!r.viable) {
      skipped.push(r.symbol)
      continue
    }
    await db.update(gridConfigs)
      .set({ budgetPct: r.proposedBudgetPct, updatedAt: new Date() })
      .where(eq(gridConfigs.symbol, r.symbol))
    applied++
  }
  return { applied, skipped }
}

/**
 * Scheduled entry point — called every 5 hours from instrumentation.ts.
 * Computes the rebalance, and only applies it if the circuit breaker is
 * satisfied (not too much missing candle data). Always logs the outcome to
 * bot_logs so it's visible in the dashboard, whether it applied or skipped.
 */
export async function autoRebalance(timeframe = "Min15"): Promise<void> {
  const result = await computePortfolioRebalance(timeframe)
  if (result.risks.length === 0) {
    return // nothing enabled, nothing to do
  }
  if (!result.dataQualityOk) {
    await log("error", `[Rebalance] Skipped auto-apply: ${(result.failureRatio * 100).toFixed(0)}% of pairs had candle fetch failures (${result.failedSymbols.join(", ")}). Will retry next cycle.`)
    return
  }
  const applyResult = await applyRebalance(result.risks)
  const changes = result.risks
    .filter((r) => r.viable && Math.abs(r.proposedBudgetPct - r.currentBudgetPct) >= 0.1)
    .map((r) => `${r.symbol}: ${r.currentBudgetPct}%->${r.proposedBudgetPct}%`)
    .join(", ")
  await log("info", `[Rebalance] Auto-applied to ${applyResult.applied} pair(s), skipped ${applyResult.skipped.length} (${applyResult.skipped.join(", ") || "none"}) for insufficient notional. Changes: ${changes || "none significant"}`)
}

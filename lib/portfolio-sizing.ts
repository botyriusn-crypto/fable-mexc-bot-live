import { db } from "./db"
import { gridConfigs } from "./db/schema"
import { eq } from "drizzle-orm"
import { getAccountAssets } from "./mexc/private"
import { fetchKlines } from "./mexc/public"
import type { Candle } from "./mexc/public"

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

export interface PairRisk {
  symbol: string
  timeframe: string
  volatility: number       // stddev of candle-to-candle % returns
  avgCorrelation: number   // average |correlation| to every other enabled pair
  rawWeight: number        // 1 / volatility
  adjustedWeight: number   // rawWeight / (1 + avgCorrelation * penalty)
  proposedBudgetPct: number
  currentBudgetPct: number
  viable: boolean          // false if proposed allocation can't clear MIN_NOTIONAL
  reason?: string
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

/**
 * Compute volatility-inverse, correlation-shrunk budget weights for all
 * currently enabled grid pairs. Does NOT write to the database — call
 * applyRebalance() separately once you've reviewed the proposal.
 */
export async function computePortfolioRebalance(timeframe = "Min15"): Promise<PairRisk[]> {
  const enabled = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
  if (enabled.length === 0) return []

  let availableBalance = 0
  try {
    const assets = (await getAccountAssets()) as any[]
    const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
    availableBalance = usdt ? Number(usdt.availableBalance) : 0
  } catch {
    availableBalance = 0
  }

  // Fetch candles for every enabled pair in parallel. A single symbol's
  // fetch failing shouldn't take down the whole rebalance — fall back to a
  // penalized (higher, not lower) assumed volatility for it instead.
  const candleResults = await Promise.all(
    enabled.map(async (gc) => {
      try {
        const candles = await fetchKlines(gc.symbol, timeframe, 100)
        return { symbol: gc.symbol, candles, ok: true as const }
      } catch (err) {
        return { symbol: gc.symbol, candles: [] as Candle[], ok: false as const }
      }
    })
  )

  const returnsBySymbol = new Map<string, number[]>()
  for (const r of candleResults) {
    returnsBySymbol.set(r.symbol, r.ok ? pctReturns(r.candles) : [])
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
    }
  })

  const totalAdjustedWeight = risks.reduce((a, r) => a + r.adjustedWeight, 0)

  for (const r of risks) {
    let pct = totalAdjustedWeight > 0
      ? (r.adjustedWeight / totalAdjustedWeight) * totalBudgetCap
      : totalBudgetCap / risks.length
    pct = Math.max(MIN_BUDGET_PCT, Math.min(MAX_BUDGET_PCT, pct))
    r.proposedBudgetPct = Math.round(pct * 10) / 10

    // Viability check: at this pair's current leverage/levels, can the new
    // budget clear MIN_NOTIONAL per order? Uses live config, not assumptions.
    const gc = enabled.find((g) => g.symbol === r.symbol)!
    const budget = (availableBalance * r.proposedBudgetPct) / 100
    const sidesPerLevel = gc.direction === "neutral" ? 2 : 1
    const levels = Math.max(1, Math.min(4, Math.floor(gc.levels / 2)))
    const notionalPerLevel = (budget * gc.leverage) / (levels * sidesPerLevel)
    if (notionalPerLevel < MIN_NOTIONAL) {
      r.viable = false
      r.reason = `Proposed budget ${r.proposedBudgetPct}% -> $${budget.toFixed(2)} can't clear $${MIN_NOTIONAL} minimum notional per order at ${levels} levels/side. Consider disabling this pair or consolidating capital into fewer pairs.`
    }
  }

  return risks
}

/**
 * Actually writes the proposed budgetPct to every enabled pair. Call
 * computePortfolioRebalance() first and review the output — this does not
 * re-derive anything, it applies exactly what you pass it.
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

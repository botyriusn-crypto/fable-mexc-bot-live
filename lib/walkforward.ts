// Walk-forward gauntlet framework (pure, no I/O).
//
// One bar for every strategy: split history into sequential folds, score each
// fold from its trade list, then verdict PASS / FAIL / INCONCLUSIVE with
// stated reasons. Strategies plug in by producing trades per fold; this file
// owns folds, metrics, regime attribution, and the verdict — nothing else.
//
// The bar (explicit, adjustable via PassBar):
//   - INCONCLUSIVE when total trades < minTrades (default 20): no verdict
//     from noise. One winning trade must never read as validation.
//   - FAIL when aggregate net after costs <= 0.
//   - FAIL when fewer than a majority of traded folds are positive.
//   - FAIL when any fold's drawdown exceeds maxDrawdownPct (default 0.20 —
//     the repo's own kill-switch level, RISK_LIMITS.maxDrawdownPct).
//   - Else PASS.

import { computeSnapshot } from "./indicators"
import { detectRegime } from "./strategy"
import type { Candle } from "./mexc/public"
import type { BotConfig } from "./db/schema"
import type { BacktestReport } from "./scalp-backtest"

export interface FoldSpec {
  /** Index of the first SCORED bar (inclusive). */
  scoredStart: number
  /** Index past the last scored bar (exclusive). */
  scoredEnd: number
  /** Series slice start (includes unscored context for indicators). */
  seriesStart: number
  seriesEnd: number
}

export interface FoldMetrics {
  n: number
  net: number
  wins: number
  profitFactor: number
  winRate: number
  maxDrawdownPct: number
}

export interface PassBar {
  minTrades: number
  majorityWins: boolean
  maxDrawdownPct: number
}

export const DEFAULT_BAR: PassBar = {
  minTrades: 20,
  majorityWins: true,
  maxDrawdownPct: 0.2,
}

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE"

export interface WalkForwardVerdict {
  verdict: Verdict
  reasons: string[]
  folds: FoldMetrics[]
  aggregateNet: number
  aggregateTrades: number
}

/**
 * Sequential non-overlapping folds over the most recent history.
 * embargoBars of unscored candles separate folds so a max-hold exit can't
 * bleed across a boundary; contextBars of leading history feed indicators.
 */
export function splitFolds(
  totalBars: number,
  folds: number,
  foldBars: number,
  embargoBars: number,
  contextBars: number,
): FoldSpec[] {
  const span = folds * foldBars + (folds - 1) * embargoBars
  const base = Math.max(0, totalBars - span)
  const out: FoldSpec[] = []
  for (let k = 0; k < folds; k++) {
    const scoredStart = base + k * (foldBars + embargoBars)
    const scoredEnd = Math.min(totalBars, scoredStart + foldBars)
    out.push({
      scoredStart,
      scoredEnd,
      seriesStart: Math.max(0, scoredStart - contextBars),
      seriesEnd: scoredEnd,
    })
  }
  return out
}

/** Fold metrics from a trade pnl sequence over a start equity (equity reset per fold). */
export function summarizeFold(pnls: number[], startEquity: number): FoldMetrics {
  const wins = pnls.filter((p) => p > 0)
  const grossWin = wins.reduce((s, p) => s + p, 0)
  const grossLoss = Math.abs(pnls.filter((p) => p <= 0).reduce((s, p) => s + p, 0))
  let equity = startEquity
  let peak = equity
  let maxDD = 0
  for (const p of pnls) {
    equity += p
    peak = Math.max(peak, equity)
    if (peak > 0) maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100)
  }
  return {
    n: pnls.length,
    net: pnls.reduce((s, p) => s + p, 0),
    wins: wins.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    winRate: pnls.length ? wins.length / pnls.length : 0,
    maxDrawdownPct: maxDD,
  }
}

export function verdictFromFolds(folds: FoldMetrics[], bar: PassBar = DEFAULT_BAR): WalkForwardVerdict {
  const reasons: string[] = []
  const traded = folds.filter((f) => f.n > 0)
  const aggregateTrades = folds.reduce((s, f) => s + f.n, 0)
  const aggregateNet = folds.reduce((s, f) => s + f.net, 0)
  if (aggregateTrades < bar.minTrades) {
    return {
      verdict: "INCONCLUSIVE",
      reasons: [`only ${aggregateTrades} trades (< ${bar.minTrades} minimum) — no verdict from noise`],
      folds,
      aggregateNet,
      aggregateTrades,
    }
  }
  let verdict: Verdict = "PASS"
  if (!(aggregateNet > 0)) {
    verdict = "FAIL"
    reasons.push(`aggregate net ${aggregateNet.toFixed(2)} <= 0 after costs`)
  }
  if (bar.majorityWins) {
    const pos = traded.filter((f) => f.net > 0).length
    if (!(pos * 2 > traded.length)) {
      verdict = "FAIL"
      reasons.push(`only ${pos}/${traded.length} traded folds positive — no majority`)
    }
  }
  const worstDD = Math.max(0, ...folds.map((f) => f.maxDrawdownPct))
  if (worstDD > bar.maxDrawdownPct * 100) {
    verdict = "FAIL"
    reasons.push(`worst fold drawdown ${worstDD.toFixed(1)}% exceeds ${(bar.maxDrawdownPct * 100).toFixed(0)}% cap`)
  }
  if (verdict === "PASS") {
    reasons.push(
      `aggregate net +${aggregateNet.toFixed(2)} over ${aggregateTrades} trades, ` +
        `${traded.filter((f) => f.net > 0).length}/${traded.length} folds positive, worst DD ${worstDD.toFixed(1)}%`,
    )
  }
  return { verdict, reasons, folds, aggregateNet, aggregateTrades }
}

export type RegimeLabel = "trend" | "range" | "neutral" | "unknown"

/**
 * Regime at entry under the closed-bar contract: only candles that closed at
 * or before the entry bar may influence the label. window covers
 * [entryBar - windowBars, entryBar) — the entry bar itself is EXCLUDED, so a
 * violent move after entry can never rewrite the label (no look-ahead).
 */
export function attributeRegime(
  candles: Candle[],
  entryBar: number,
  trendThreshold: number,
  rangeThreshold: number,
  windowBars = 200,
): RegimeLabel {
  if (entryBar < 30) return "unknown"
  const window = candles.slice(Math.max(0, entryBar - windowBars), entryBar)
  if (window.length < 30) return "unknown"
  const cfg = {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    atrPeriod: 14,
    adxTrendThreshold: trendThreshold,
    adxRangeThreshold: rangeThreshold,
  } as unknown as BotConfig
  const snap = computeSnapshot(window, cfg)
  return detectRegime(snap, cfg)
}

/** Per-regime net/win split for a fold's trades (report, not gate). */
export function regimeSplit(
  report: BacktestReport,
  candles: Candle[],
  trendThreshold: number,
  rangeThreshold: number,
): Record<RegimeLabel, { n: number; net: number }> {
  const out: Record<RegimeLabel, { n: number; net: number }> = {
    trend: { n: 0, net: 0 },
    range: { n: 0, net: 0 },
    neutral: { n: 0, net: 0 },
    unknown: { n: 0, net: 0 },
  }
  for (const t of report.trades) {
    const r = attributeRegime(candles, t.bar, trendThreshold, rangeThreshold)
    out[r].n += 1
    out[r].net += t.pnl
  }
  return out
}

export interface ConcentrationEntry {
  key: string
  net: number
}

export interface ConcentrationCheck {
  totalNet: number
  /** Top contributors by |net|, descending. */
  top: ConcentrationEntry[]
  survivesTop1: boolean
  survivesTop2: boolean
  concentrated: boolean
}

const signOf = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0)

/**
 * Does an aggregate result survive removing its largest contributors?
 * Ratio-free by design: "share of net total" explodes on small/near-zero
 * denominators, and a flat percentage ignores contributor count (40% of 5
 * is mild, 40% of 15 is damning). Sign-flip is robust to both. A zero total
 * is uninformative, so it never "survives". Same function serves both axes:
 * map per-symbol nets for symbol concentration, per-fold nets for fold
 * concentration. Pure.
 */
export function concentrationSurvival(entries: ConcentrationEntry[]): ConcentrationCheck {
  const ranked = [...entries].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  const totalNet = entries.reduce((s, e) => s + e.net, 0)
  const base = signOf(totalNet)
  const rest = (k: number): number =>
    totalNet - ranked.slice(0, k).reduce((s, e) => s + e.net, 0)
  // Removal must preserve a nonzero sign: dropping to exactly zero (or from
  // zero) proves nothing and counts as concentrated, not robust.
  const survives = (k: number): boolean =>
    base !== 0 && ranked.length > k && signOf(rest(k)) === base
  const survivesTop1 = survives(1)
  const survivesTop2 = survives(2)
  return {
    totalNet,
    top: ranked.slice(0, 2),
    survivesTop1,
    survivesTop2,
    concentrated: !survivesTop1 || !survivesTop2,
  }
}

export interface AdvantageCheck {
  /** Contender total minus baseline total (the claimed improvement). */
  advantage: number
  survivesTop1: boolean
  survivesTop2: boolean
  /** Top carriers of the advantage (largest toward-sign diffs first). */
  top: { key: string; diff: number }[]
  /** True when the advantage flips or vanishes without its top carriers. */
  evaporates: boolean
}

/**
 * Does arm B's advantage over arm A survive removing the keys that carry
 * it? This is the check that caught the +709 case: sign-survival of the
 * total passed (+381 without TAO/ENA), but the +232 any-vs-neutral
 * advantage lived entirely in ENA (+197) and TAO (+56) — removing two keys
 * flipped it to −21. Per-key diffs, never ratios. Pure.
 */
export function advantageSurvives(
  baseline: ConcentrationEntry[],
  contender: ConcentrationEntry[],
): AdvantageCheck {
  const baseByKey = new Map(baseline.map((e) => [e.key, e.net] as const))
  const diffs = contender.map((c) => ({
    key: c.key,
    diff: c.net - (baseByKey.get(c.key) ?? 0),
  }))
  const advantage = diffs.reduce((s, d) => s + d.diff, 0)
  const base = signOf(advantage)
  // Rank by contribution TOWARD the advantage's sign, not |diff|: removing a
  // drag (opposite-sign diff) adds back to the total and must not count as
  // stress-testing the carriers. Symmetric for negative advantages.
  const ranked = [...diffs].sort((a, b) => b.diff * base - a.diff * base)
  const survives = (k: number): boolean => {
    if (base === 0 || ranked.length <= k) return false
    const rest = advantage - ranked.slice(0, k).reduce((s, d) => s + d.diff, 0)
    return signOf(rest) === base
  }
  const survivesTop1 = survives(1)
  const survivesTop2 = survives(2)
  return {
    advantage,
    survivesTop1,
    survivesTop2,
    top: ranked.slice(0, 2),
    evaporates: !survivesTop1 || !survivesTop2,
  }
}

/**
 * Expected backtest timeframe per arm. The scalper trades 5–15m, so scalp
 * arms validated anywhere else do not validate production — the neutral
 * gate shipped on hourly results for a 15m strategy and cost a full
 * re-validation. Grid is deliberately unpinned: it is genuinely multi-TF
 * (8 user-selectable timeframes Min1–Day1, schema default Min5, rotator and
 * AI advisor pin Min15), so no single TF assertion would be honest. If grid
 * ever consolidates on one execution TF, pin it here.
 */
export function expectedArmTf(arm: string): number | null {
  if (arm.startsWith("scalp")) return 15
  return null
}

/** Non-null message when a run's TF doesn't validate its arm; else null. */
export function armTfMismatch(tfMin: number, arm: string): string | null {
  const expected = expectedArmTf(arm)
  if (expected == null || tfMin === expected) return null
  return `TF MISMATCH: arm "${arm}" validates ${expected}m execution but ran on ${tfMin}m — results do not validate production`
}

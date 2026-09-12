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

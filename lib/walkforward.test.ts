import { describe, expect, it } from "vitest"
import {
  splitFolds,
  summarizeFold,
  verdictFromFolds,
  attributeRegime,
  regimeSplit,
  type FoldMetrics,
} from "./walkforward"
import type { Candle } from "./mexc/public"
import type { BacktestReport } from "./scalp-backtest"

const fm = (n: number, net: number, maxDD = 1): FoldMetrics => ({
  n, net, wins: net > 0 ? n : 0, profitFactor: net > 0 ? 2 : 0.5, winRate: 0.5, maxDrawdownPct: maxDD,
})

describe("splitFolds", () => {
  it("lays sequential non-overlapping folds with embargo and context", () => {
    // 100 bars, 2 folds x 40, embargo 10, context 5 → span 90, base 10.
    const folds = splitFolds(100, 2, 40, 10, 5)
    expect(folds).toEqual([
      { scoredStart: 10, scoredEnd: 50, seriesStart: 5, seriesEnd: 50 },
      { scoredStart: 60, scoredEnd: 100, seriesStart: 55, seriesEnd: 100 },
    ])
  })

  it("clamps to available history instead of going negative", () => {
    const folds = splitFolds(50, 5, 40, 10, 5)
    expect(folds).toHaveLength(5)
    expect(folds[0].scoredStart).toBeGreaterThanOrEqual(0)
    expect(folds[0].seriesStart).toBeGreaterThanOrEqual(0)
    for (let k = 1; k < folds.length; k++) {
      expect(folds[k].scoredStart).toBeGreaterThanOrEqual(folds[k - 1].scoredEnd)
    }
  })
})

describe("summarizeFold", () => {
  it("aggregates net, PF and drawdown from an equity reset", () => {
    const m = summarizeFold([10, -4, 6], 1000)
    expect(m.n).toBe(3)
    expect(m.net).toBe(12)
    expect(m.profitFactor).toBeCloseTo(16 / 4, 10)
    expect(m.maxDrawdownPct).toBeCloseTo((4 / 1010) * 100, 10)
  })

  it("reports zero trades without NaN", () => {
    const m = summarizeFold([], 1000)
    expect(m.n).toBe(0)
    expect(m.net).toBe(0)
    expect(m.profitFactor).toBe(0)
    expect(m.maxDrawdownPct).toBe(0)
  })
})

describe("verdictFromFolds", () => {
  it("passes a profitable majority with bounded drawdown", () => {
    const v = verdictFromFolds([fm(10, 50), fm(10, 30), fm(10, -5), fm(10, 20), fm(10, 10)])
    expect(v.verdict).toBe("PASS")
    expect(v.aggregateTrades).toBe(50)
  })

  it("fails negative aggregate net", () => {
    const v = verdictFromFolds([fm(10, -50), fm(10, -30)])
    expect(v.verdict).toBe("FAIL")
    expect(v.reasons.join(" ")).toMatch(/<= 0/)
  })

  it("fails without a positive-fold majority", () => {
    const v = verdictFromFolds([fm(10, 100), fm(10, -10), fm(10, -10), fm(10, -10)])
    expect(v.verdict).toBe("FAIL")
    expect(v.reasons.join(" ")).toMatch(/majority/)
  })

  it("fails a drawdown beyond the kill-switch cap", () => {
    const v = verdictFromFolds([fm(10, 50, 5), fm(10, 40, 25)])
    expect(v.verdict).toBe("FAIL")
    expect(v.reasons.join(" ")).toMatch(/drawdown/)
  })

  it("refuses verdicts from noise (INCONCLUSIVE), never passes one trade", () => {
    const v = verdictFromFolds([fm(0, 0), fm(1, 21.93), fm(0, 0)])
    expect(v.verdict).toBe("INCONCLUSIVE")
  })
})

/** Deterministic candles: steady fractional drift, no noise. */
function driftCandles(n: number, start: number, drift: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const close = start * (1 + drift * i)
    const open = i === 0 ? start : out[i - 1].close
    out.push({ time: i, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1000 })
  }
  return out
}

describe("attributeRegime", () => {
  it("labels a sustained drift as trend and flat as range", () => {
    const trend = driftCandles(260, 100, 0.003)
    expect(attributeRegime(trend, 250, 25, 20)).toBe("trend")
    const flat = driftCandles(260, 100, 0)
    expect(attributeRegime(flat, 250, 25, 20)).toBe("range")
  })

  it("ignores candles after the entry bar (no look-ahead)", () => {
    const before = driftCandles(250, 100, 0.003)
    const afterCrash = [...before, ...driftCandles(30, before[before.length - 1].close, -0.05)]
    // Entry at bar 240: identical history in both series → identical label,
    // even though one series crashes right after.
    expect(attributeRegime(afterCrash, 240, 25, 20)).toBe(attributeRegime(before, 240, 25, 20))
  })

  it("returns unknown without enough history", () => {
    expect(attributeRegime(driftCandles(260, 100, 0.003), 10, 25, 20)).toBe("unknown")
  })
})

describe("regimeSplit", () => {
  it("buckets every trade and conserves the totals", () => {
    const candles = driftCandles(260, 100, 0.003)
    const report = {
      trades: [
        { bar: 200, pnl: 5 },
        { bar: 220, pnl: -3 },
        { bar: 240, pnl: 7 },
      ],
    } as unknown as BacktestReport
    const split = regimeSplit(report, candles, 25, 20)
    const n = split.trend.n + split.range.n + split.neutral.n + split.unknown.n
    const net = split.trend.net + split.range.net + split.neutral.net + split.unknown.net
    expect(n).toBe(3)
    expect(net).toBe(9)
  })
})

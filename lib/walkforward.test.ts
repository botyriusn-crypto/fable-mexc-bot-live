import { describe, expect, it } from "vitest"
import {
  splitFolds,
  summarizeFold,
  verdictFromFolds,
  attributeRegime,
  regimeSplit,
  concentrationSurvival,
  advantageSurvives,
  armTfMismatch,
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

describe("concentrationSurvival", () => {
  it("passes a genuinely broad result", () => {
    const c = concentrationSurvival([
      { key: "A", net: 100 }, { key: "B", net: 90 }, { key: "C", net: 80 },
      { key: "D", net: 60 }, { key: "E", net: 50 },
    ])
    expect(c.concentrated).toBe(false)
    expect(c.survivesTop1).toBe(true)
    expect(c.survivesTop2).toBe(true)
  })

  it("flags a result carried by one key, without any ratio", () => {
    const c = concentrationSurvival([
      { key: "PUMP", net: 489 }, { key: "SOL", net: 30 }, { key: "HYPE", net: -44 },
    ])
    expect(c.concentrated).toBe(true)
    expect(c.survivesTop1).toBe(false)
    expect(c.top[0].key).toBe("PUMP")
  })

  it("treats zero and near-zero totals as uninformative, not robust", () => {
    expect(concentrationSurvival([]).concentrated).toBe(true)
    expect(concentrationSurvival([{ key: "A", net: 50 }, { key: "B", net: -50 }]).concentrated).toBe(true)
  })

  it("serves the fold axis too: single-fold dominance flags", () => {
    const c = concentrationSurvival([
      { key: "fold0", net: -32 }, { key: "fold1", net: 182 }, { key: "fold2", net: 21 },
      { key: "fold3", net: 10 }, { key: "fold4", net: -20 },
    ])
    expect(c.concentrated).toBe(true)
    expect(c.top[0]).toEqual({ key: "fold1", net: 182 })
  })
})

describe("advantageSurvives", () => {
  // Session regression: 15m any-regime (+709) vs neutral-only (+477).
  // Sign-survival of the total passes without TAO/ENA (+381), but the +232
  // advantage lives in ENA (+197) and TAO (+56) — removing two keys flips
  // it to −21. The revert failed its own conditional; the check must too.
  const neutral = [
    { key: "BTC", net: 12 }, { key: "ETH", net: -4 }, { key: "SOL", net: -6 },
    { key: "XRP", net: -21 }, { key: "HYPE", net: 36 }, { key: "ZEC", net: 37 },
    { key: "DOGE", net: -9 }, { key: "SUI", net: 68 }, { key: "LINK", net: 4 },
    { key: "TAO", net: 111 }, { key: "ENA", net: -36 }, { key: "AAVE", net: 119 },
    { key: "ADA", net: -5 }, { key: "WLD", net: 73 }, { key: "AVAX", net: 98 },
  ]
  const anyRegime = [
    { key: "BTC", net: -2 }, { key: "ETH", net: -6 }, { key: "SOL", net: -47 },
    { key: "XRP", net: 22 }, { key: "HYPE", net: 90 }, { key: "ZEC", net: 29 },
    { key: "DOGE", net: 44 }, { key: "SUI", net: 31 }, { key: "LINK", net: 8 },
    { key: "TAO", net: 167 }, { key: "ENA", net: 161 }, { key: "AAVE", net: 101 },
    { key: "ADA", net: -90 }, { key: "WLD", net: 65 }, { key: "AVAX", net: 127 },
  ]

  it("evaporates when the advantage's carriers are removed", () => {
    const a = advantageSurvives(neutral, anyRegime)
    expect(a.advantage).toBeGreaterThan(200)
    expect(a.top[0]).toEqual({ key: "ENA", diff: 197 })
    expect(a.top[1]).toEqual({ key: "TAO", diff: 56 })
    expect(a.survivesTop1).toBe(true)
    expect(a.survivesTop2).toBe(false)
    expect(a.evaporates).toBe(true)
  })

  it("holds when the advantage is broad", () => {
    const base = neutral.map((e) => ({ key: e.key, net: 0 }))
    const cont = neutral.map((e) => ({ key: e.key, net: 10 }))
    const a = advantageSurvives(base, cont)
    expect(a.evaporates).toBe(false)
  })

  it("a zero advantage is not a surviving advantage", () => {
    const a = advantageSurvives(neutral, [...neutral])
    expect(a.advantage).toBe(0)
    expect(a.evaporates).toBe(true)
  })
})

describe("armTfMismatch", () => {
  it("pins scalp arms to 15m and leaves other arms alone", () => {
    expect(armTfMismatch(15, "scalp (any regime)")).toBeNull()
    expect(armTfMismatch(60, "scalp (any regime)")).toContain("15m")
    expect(armTfMismatch(60, "scalp (neutral only)")).toContain("15m")
    expect(armTfMismatch(60, "grid")).toBeNull()
    expect(armTfMismatch(15, "grid")).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import {
  isFlatForAutoSwitch,
  pickWinner,
  rankTrendCandidates,
  scoreTrendCandidate,
  screenUniverse,
} from "./trend-candidate"
import type { Candle } from "./mexc/public"

/** Deterministic synthetic candles: steady drift + oscillation so swings/ADX form. */
function buildCandles(opts: {
  n?: number
  start?: number
  drift?: number // per-candle fractional drift, + up / - down
  volume?: number
  endVolumeMult?: number
}): Candle[] {
  const { n = 60, start = 100, drift = 0.005, volume = 1000, endVolumeMult = 1 } = opts
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const trend = start * (1 + drift * i)
    const wave = Math.sin(i * 1.1) * start * 0.003
    const close = trend + wave
    const open = i === 0 ? start : out[i - 1].close
    out.push({
      time: i,
      open,
      high: Math.max(open, close) + start * 0.0015,
      low: Math.min(open, close) - start * 0.0015,
      close,
      volume: i >= n - 2 ? volume * endVolumeMult : volume,
    })
  }
  return out
}

describe("trend-candidate", () => {
  it("scores a volume-backed uptrend as a tradable long", () => {
    const s = scoreTrendCandidate({
      symbol: "HYPE_USDT",
      candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
      lastPrice: 130,
      turnover24h: 50_000_000,
      riseFallRate24h: 0.12,
      fundingRate: -0.0008, // crowded shorts + rising = squeeze fuel
    })
    expect(s.direction).toBe("long")
    expect(s.tradable).toBe(true)
    expect(s.score).toBeGreaterThanOrEqual(50)
    expect(s.reasons.join(" ")).toMatch(/ADX/)
  })

  it("scores a mirror downtrend as a short", () => {
    const s = scoreTrendCandidate({
      symbol: "DUMP_USDT",
      candles: buildCandles({ drift: -0.005, endVolumeMult: 3 }),
      lastPrice: 70,
      turnover24h: 50_000_000,
      riseFallRate24h: -0.12,
      fundingRate: 0.0008,
    })
    expect(s.direction).toBe("short")
    expect(s.tradable).toBe(true)
  })

  it("rejects chop and illiquid coins", () => {
    const flat = scoreTrendCandidate({
      symbol: "FLAT_USDT",
      candles: buildCandles({ drift: 0 }),
      lastPrice: 100,
      turnover24h: 50_000_000,
    })
    expect(flat.tradable).toBe(false)
    expect(flat.score).toBeLessThan(35)

    const illiquid = scoreTrendCandidate({
      symbol: "TINY_USDT",
      candles: buildCandles({ drift: 0.01, endVolumeMult: 5 }),
      lastPrice: 1,
      turnover24h: 1_000,
    })
    expect(illiquid.score).toBe(0)
    expect(illiquid.disqualified).toMatch(/illiquid/)
  })

  it("accepts manual hype/news edge without changing the signature", () => {
    const base = {
      symbol: "NEWS_USDT",
      candles: buildCandles({ drift: 0.003 }),
      lastPrice: 110,
      turnover24h: 50_000_000,
      riseFallRate24h: 0.06,
    } as const
    const plain = scoreTrendCandidate({ ...base })
    const withHype = scoreTrendCandidate({
      ...base,
      external: { edge: 1, note: "ETF rumor" },
    })
    expect(withHype.score).toBeGreaterThan(plain.score)
    expect(withHype.reasons.join(" ")).toMatch(/ETF rumor/)
  })

  it("rides an early-stage PUMP-style runner, with cautions attached", () => {
    // Strong-but-tradeable hype runner: volume explosion, mild crowded-long
    // funding, not yet a vertical blowoff. Expect: long wins AND the reasons
    // still show the squeeze headwind and the chase penalty.
    const s = scoreTrendCandidate({
      symbol: "PUMP_USDT",
      candles: buildCandles({ drift: 0.006, endVolumeMult: 4 }),
      lastPrice: 0.006,
      turnover24h: 200_000_000,
      riseFallRate24h: 0.12,
      fundingRate: 0.0003,
    })
    expect(s.direction).toBe("long")
    expect(s.tradable).toBe(true)
    const text = s.reasons.join(" ")
    expect(text).toMatch(/crowded/)
    expect(text).toMatch(/chase risk/)
  })

  it("refuses to auto-pick a vertical late-stage blowoff", () => {
    // +2%/candle vertical, +60% day, fully crowded: the only honest answer is
    // no auto-pick — FIND must leave the selector alone here.
    const blowoff = {
      symbol: "PUMP_USDT",
      candles: buildCandles({ drift: 0.02, endVolumeMult: 8 }),
      lastPrice: 0.006,
      turnover24h: 200_000_000,
      riseFallRate24h: 0.6,
      fundingRate: 0.001,
    } as const
    expect(pickWinner(rankTrendCandidates([{ ...blowoff }]))).toBeNull()
  })

  it("ranks best-first and pre-screens a universe without klines", () => {
    const ranked = rankTrendCandidates([
      {
        symbol: "FLAT_USDT",
        candles: buildCandles({ drift: 0 }),
        lastPrice: 100,
        turnover24h: 50_000_000,
      },
      {
        symbol: "HYPE_USDT",
        candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
        lastPrice: 130,
        turnover24h: 50_000_000,
        riseFallRate24h: 0.12,
        fundingRate: -0.0008,
      },
    ])
    expect(ranked[0].symbol).toBe("HYPE_USDT")

    const picks = screenUniverse(
      [
        { symbol: "A_USDT", turnover24h: 100_000_000, riseFallRate24h: 0.01 },
        { symbol: "B_USDT", turnover24h: 80_000_000, riseFallRate24h: 0.15, fundingRate: -0.001 },
        { symbol: "C_USDT", turnover24h: 1_000, riseFallRate24h: 0.9 },
      ],
      2,
    )
    expect(picks).toEqual(["B_USDT", "A_USDT"])
  })

  it("disqualifies sub-half-cent coins (PEPE-class) from auto-select", () => {
    const pepe = scoreTrendCandidate({
      symbol: "1000PEPE_USDT",
      candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
      lastPrice: 0.0034,
      turnover24h: 200_000_000, // huge turnover must NOT save it
      riseFallRate24h: 0.12,
    })
    expect(pepe.score).toBe(0)
    expect(pepe.tradable).toBe(false)
    expect(pepe.disqualified).toMatch(/below.*minimum/)
    // A disqualified PEPE can never win auto-select, even ranked first.
    expect(pickWinner(rankTrendCandidates([
      {
        symbol: "1000PEPE_USDT",
        candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
        lastPrice: 0.0034,
        turnover24h: 200_000_000,
        riseFallRate24h: 0.12,
      },
    ]))).toBeNull()
    // Override still allows opting back in explicitly.
    const allowed = scoreTrendCandidate({
      symbol: "1000PEPE_USDT",
      candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
      lastPrice: 0.0034,
      turnover24h: 200_000_000,
      riseFallRate24h: 0.12,
      minPriceUsdt: 0.001,
    })
    expect(allowed.disqualified).toBeUndefined()
  })

  it("pre-screens known-cheap coins out of the universe, keeps unknown-price rows", () => {
    const picks = screenUniverse(
      [
        { symbol: "PEPE_USDT", turnover24h: 200_000_000, riseFallRate24h: 0.2, lastPrice: 0.0034 },
        { symbol: "OK_USDT", turnover24h: 100_000_000, riseFallRate24h: 0.1, lastPrice: 2.5 },
        { symbol: "MYST_USDT", turnover24h: 100_000_000, riseFallRate24h: 0.1 },
      ],
      5,
    )
    expect(picks).not.toContain("PEPE_USDT")
    expect(picks).toContain("OK_USDT")
    expect(picks).toContain("MYST_USDT") // unknown price: pre-screen passes, deep score fails closed
  })

  it("picks the top tradable setup as the auto-select winner", () => {
    expect(pickWinner([])).toBeNull()
    const ranked = rankTrendCandidates([
      {
        symbol: "FLAT_USDT",
        candles: buildCandles({ drift: 0 }),
        lastPrice: 100,
        turnover24h: 50_000_000,
      },
      {
        symbol: "HYPE_USDT",
        candles: buildCandles({ drift: 0.005, endVolumeMult: 3 }),
        lastPrice: 130,
        turnover24h: 50_000_000,
        riseFallRate24h: 0.12,
        fundingRate: -0.0008,
      },
    ])
    expect(pickWinner(ranked)?.symbol).toBe("HYPE_USDT")
    // Nothing tradable → no winner, selector stays put.
    expect(pickWinner(rankTrendCandidates([
      {
        symbol: "FLAT_USDT",
        candles: buildCandles({ drift: 0 }),
        lastPrice: 100,
        turnover24h: 50_000_000,
      },
    ]))).toBeNull()
  })

  it("only allows auto-switch when fully flat", () => {
    expect(isFlatForAutoSwitch({ openPositions: [], grid: { orders: [] } })).toBe(true)
    expect(isFlatForAutoSwitch({ openPositions: [], grid: null })).toBe(true)
    expect(isFlatForAutoSwitch({ openPositions: [{}], grid: { orders: [] } })).toBe(false)
    expect(
      isFlatForAutoSwitch({ openPositions: [], grid: { orders: [{ status: "pending" }] } }),
    ).toBe(false)
    expect(
      isFlatForAutoSwitch({
        openPositions: [],
        grid: { orders: [{ status: "filled" }, { status: "cancelled" }] },
      }),
    ).toBe(true)
  })
})

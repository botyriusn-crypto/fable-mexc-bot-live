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

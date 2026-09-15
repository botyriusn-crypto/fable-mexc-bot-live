import { describe, expect, it } from "vitest"
import { isPriceEligible, quoteVolume24h, isRealizedLoser } from "./ai-grid-advisor"
import { DEFAULT_MIN_CANDIDATE_PRICE } from "./trend-candidate"

describe("isPriceEligible", () => {
  it("shares the trend auto-select floor", () => {
    expect(DEFAULT_MIN_CANDIDATE_PRICE).toBe(0.005)
  })

  it("rejects PEPE-class prices, accepts normal ones", () => {
    expect(isPriceEligible(0.0034)).toBe(false)
    expect(isPriceEligible(0.004999)).toBe(false)
    expect(isPriceEligible(0.005)).toBe(true)
    expect(isPriceEligible(0.006)).toBe(true)
    expect(isPriceEligible(2.5)).toBe(true)
  })

  it("fails closed on unreadable prices", () => {
    expect(isPriceEligible(undefined)).toBe(false)
    expect(isPriceEligible(null)).toBe(false)
    expect(isPriceEligible(0)).toBe(false)
    expect(isPriceEligible(NaN)).toBe(false)
    expect(isPriceEligible(Infinity)).toBe(false)
  })

  it("honors an explicit override", () => {
    expect(isPriceEligible(0.0034, 0.001)).toBe(true)
    expect(isPriceEligible(2.5, 10)).toBe(false)
  })
})

describe("quoteVolume24h", () => {
  it("prefers explicit quote turnover", () => {
    // BTC: 2k base volume would fail a 15M floor; $140M turnover passes.
    expect(quoteVolume24h({ volume24: 2000, amount24: 140_000_000, lastPrice: 70000 })).toBe(140_000_000)
  })

  it("converts base volume via last price when turnover is absent", () => {
    expect(quoteVolume24h({ volume24: 2000, lastPrice: 70000 })).toBe(140_000_000)
    // PEPE-class: billions of base units stay billions of quote millis — the
    // floor must see quote, not base.
    expect(quoteVolume24h({ volume24: 5_000_000_000, lastPrice: 0.0034 })).toBeCloseTo(17_000_000, 0)
  })

  it("returns 0 when nothing is readable", () => {
    expect(quoteVolume24h({})).toBe(0)
    expect(quoteVolume24h({ volume24: 100 })).toBe(0)
  })
})

describe("isRealizedLoser", () => {
  it("flags sustained losers, including break-even at the boundary", () => {
    // PEPE/ARB/DOGE class: deeply negative over a dozen closes.
    expect(isRealizedLoser(-143.87, 12)).toBe(true)
    // Mirrors the rotator's dead rule (pnl <= 0): zero is not alive.
    expect(isRealizedLoser(0, 3)).toBe(true)
  })

  it("passes winners and thin history", () => {
    expect(isRealizedLoser(37.21, 9)).toBe(false)
    // Too few closes to judge is not a proven loser (new listings pass).
    expect(isRealizedLoser(-50, 2)).toBe(false)
    expect(isRealizedLoser(-50, 0)).toBe(false)
  })

  it("fails open on unreadable stats", () => {
    expect(isRealizedLoser(NaN, 5)).toBe(false)
    expect(isRealizedLoser(-10, NaN)).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { isPriceEligible } from "./ai-grid-advisor"
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

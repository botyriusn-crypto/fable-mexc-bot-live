import { describe, expect, it } from "vitest"
import { resolveTrendPause } from "./grid"

const cfg: any = { adxTrendThreshold: 25 }
const snap = (adx: number, roc: number, price = 100, atr = 1): any => ({ price, atr, adx, roc })

describe("resolveTrendPause entry", () => {
  it("preserves the slow and fast triggers when unpaused", () => {
    // Slow leg: default bar 25 + 7 = 32.
    expect(resolveTrendPause(snap(33, 0.5), cfg)).toBe(true)
    expect(resolveTrendPause(snap(31, 0.5), cfg)).toBe(false)
    // Fast leg: single sharp bar with mild trend.
    expect(resolveTrendPause(snap(20, 3.0), cfg)).toBe(true)
    expect(resolveTrendPause(snap(20, 2.0), cfg)).toBe(false)
    // Calm chop passes.
    expect(resolveTrendPause(snap(15, 0.5), cfg)).toBe(false)
  })

  it("lowers the slow bar for high-ATR% coins", () => {
    // atrPct = 2% -> bar 25 - 1 = 24.
    expect(resolveTrendPause(snap(25, 0.5, 100, 2), cfg)).toBe(true)
    expect(resolveTrendPause(snap(20, 0.5, 100, 2), cfg)).toBe(false)
  })
})

describe("resolveTrendPause hysteresis", () => {
  it("holds the pause through the flap zone (the LINK 18:45-18:53 cycle)", () => {
    // Entry on a sharp bar.
    expect(resolveTrendPause(snap(20, 3.0), cfg, false)).toBe(true)
    // Next bar calms just below the entry trigger — fresh logic would resume
    // (and did, in 8 minutes). Hysteresis holds.
    expect(resolveTrendPause(snap(19, 2.0), cfg, true)).toBe(true)
    expect(resolveTrendPause(snap(19, 2.0), cfg, false)).toBe(false)
  })

  it("resumes only when genuinely calm", () => {
    expect(resolveTrendPause(snap(15, 0.5), cfg, true)).toBe(false)
    // Hot slow leg holds even with flat ROC.
    expect(resolveTrendPause(snap(30, 0.2), cfg, true)).toBe(true)
    // Elevated ROC alone holds even with cool ADX.
    expect(resolveTrendPause(snap(15, 2.0), cfg, true)).toBe(true)
  })
})

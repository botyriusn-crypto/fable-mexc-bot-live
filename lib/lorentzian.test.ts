import { describe, expect, it } from "vitest"
import { classifyLorentzian, combineConfirmation, lorentzianDistance, type LorentzianOptions } from "./lorentzian"
import type { Candle } from "./mexc/public"

const options: LorentzianOptions = {
  neighbors: 8,
  lookback: 160,
  confidenceThreshold: 0.25,
  useVolatilityFilter: false,
  useRegimeFilter: false,
  useAdxFilter: false,
  regimeThreshold: -0.1,
  adxThreshold: 20,
  useKernelFilter: false,
}

function candles(count: number, drift = 0.4): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * drift + Math.sin(index / 4) * 1.5
    return { time: 1_700_000_000 + index * 300, open: close - 0.2, high: close + 1, low: close - 1, close, volume: 100 + index }
  })
}

describe("Lorentzian classifier", () => {
  it("uses the log-scaled feature distance", () => {
    expect(lorentzianDistance([0, 0, 0, 0, 0], [1, 1, 1, 1, 1])).toBeCloseTo(5 * Math.log(2))
  })

  it("waits for sufficient closed-candle history", () => {
    const result = classifyLorentzian(candles(40), options)
    expect(result.ready).toBe(false)
    expect(result.allowed).toBe(false)
  })

  it("is deterministic and bounded by configured neighbors", () => {
    const data = candles(180)
    const first = classifyLorentzian(data, options)
    const second = classifyLorentzian(data, options)
    expect(first).toEqual(second)
    expect(first.neighborCount).toBe(8)
    expect(first.confidence).toBeGreaterThanOrEqual(0)
    expect(first.confidence).toBeLessThanOrEqual(1)
  })

  it("does not relabel history when only the current candle changes", () => {
    const data = candles(180)
    const changed = data.map((c) => ({ ...c }))
    changed[changed.length - 1].close += 20
    const baseline = classifyLorentzian(data, options)
    const currentChanged = classifyLorentzian(changed, options)
    expect(baseline.neighborCount).toBe(currentChanged.neighborCount)
  })
})

describe("confirmation policy", () => {
  const lorentzian = { ...classifyLorentzian(candles(180), options), allowed: true, direction: "long" as const }

  it("keeps logistic execution in observe mode", () => {
    expect(combineConfirmation("observe", "long", true, lorentzian).allowed).toBe(true)
    expect(combineConfirmation("observe", "long", false, lorentzian).allowed).toBe(false)
  })

  it("requires agreement in both mode", () => {
    expect(combineConfirmation("both", "long", true, lorentzian).allowed).toBe(true)
    expect(combineConfirmation("both", "short", true, lorentzian).allowed).toBe(false)
  })
})

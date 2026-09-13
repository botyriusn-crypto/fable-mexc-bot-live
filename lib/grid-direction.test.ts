import { describe, expect, it } from "vitest"
import { effectiveDirection } from "./grid"
import type { GridConfig } from "./db/schema"

// Minimal config shells: effectiveDirection only reads direction/symbol/
// timeframe (+ optional _autoSide). Casts keep the test free of schema churn.
const gc = (over: Record<string, unknown> = {}) =>
  ({
    symbol: "BTC_USDT",
    timeframe: "Min15",
    direction: "auto",
    ...over,
  }) as unknown as GridConfig

describe("effectiveDirection", () => {
  it("resolves auto to neutral before any tick has run", () => {
    expect(effectiveDirection(gc({ symbol: "FRESH1_USDT" }))).toBe("neutral")
  })

  it("prefers the live _autoSide set by the tick", () => {
    expect(
      effectiveDirection(gc({ symbol: "FRESH2_USDT", _autoSide: "short" })),
    ).toBe("short")
  })

  it("passes explicit directions through untouched", () => {
    expect(effectiveDirection(gc({ direction: "long" }))).toBe("long")
    expect(effectiveDirection(gc({ direction: "short" }))).toBe("short")
    expect(effectiveDirection(gc({ direction: "neutral" }))).toBe("neutral")
  })
})

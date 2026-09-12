import { describe, expect, it } from "vitest"
import { buildTakerStopTradeValues } from "./grid"
import { gridEntryRegime } from "./strategy"
import type { GridOrder, BotConfig } from "./db/schema"
import type { IndicatorSnapshot } from "./indicators"

// Minimal order shells: the builder only reads symbol/side/buyPrice/price/
// quantity/leverage/createdAt. Casts keep the test free of unrelated schema churn.
const longOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: "BTC_USDT",
    side: "sell",
    buyPrice: 100,
    price: 100,
    quantity: 2,
    leverage: 5,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  }) as unknown as GridOrder

const shortOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: "ETH_USDT",
    side: "buy",
    buyPrice: 100,
    price: 100,
    quantity: 1,
    leverage: 5,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  }) as unknown as GridOrder

describe("buildTakerStopTradeValues", () => {
  it("prices a long stop as exit-minus-entry with both-legs-taker fees", () => {
    const row = buildTakerStopTradeValues(longOrder(), 97, 0.0005, false)
    // gross = (97-100)*2 = -6; fees = (100+97)*2*0.0005 = 0.197
    expect(row.side).toBe("long")
    expect(row.fees).toBeCloseTo(0.197, 10)
    expect(row.pnl).toBeCloseTo(-6.197, 10)
    expect(row.sizeUsdt).toBe(200)
    expect(row.exitReason).toBe("stop-loss")
    expect(row.strategy).toBe("grid")
    expect(row.live).toBe(false)
    expect("openedAt" in row).toBe(false) // mirrors the maker long shape
  })

  it("prices a short stop as entry-minus-exit and carries openedAt", () => {
    const row = buildTakerStopTradeValues(shortOrder(), 103, 0.0005, true)
    // gross = (100-103)*1 = -3; fees = (100+103)*1*0.0005 = 0.1015
    expect(row.side).toBe("short")
    expect(row.fees).toBeCloseTo(0.1015, 10)
    expect(row.pnl).toBeCloseTo(-3.1015, 10)
    expect(row.live).toBe(true)
    expect((row as { openedAt?: unknown }).openedAt).toEqual(new Date("2026-09-01T00:00:00Z"))
  })

  it("falls back to the order price when buyPrice is missing", () => {
    const row = buildTakerStopTradeValues(longOrder({ buyPrice: null, price: 50 }), 49, 0.001, false)
    expect(row.entryPrice).toBe(50)
    expect(row.pnl).toBeCloseTo((49 - 50) * 2 - (50 + 49) * 2 * 0.001, 10)
  })

  it("a stop pushed far enough adverse is always a loss beyond fees", () => {
    const row = buildTakerStopTradeValues(shortOrder({ quantity: 3 }), 106, 0.0005, false)
    expect(row.pnl).toBeLessThan(-(row.fees as number))
  })

  it("carries the settled order's entry regime, NULL when pre-stamp", () => {
    expect(buildTakerStopTradeValues(shortOrder({ entryRegime: "range" }), 103, 0.0005, false).entryRegime).toBe("range")
    expect(buildTakerStopTradeValues(longOrder(), 97, 0.0005, false).entryRegime).toBeNull()
  })
})

describe("gridEntryRegime", () => {
  const cfg = { adxTrendThreshold: 25, adxRangeThreshold: 20 } as unknown as BotConfig
  const snap = (adx: number) => ({ adx }) as unknown as IndicatorSnapshot

  it("labels trend/range/neutral from closed-candle ADX", () => {
    expect(gridEntryRegime(snap(30), cfg)).toBe("trend")
    expect(gridEntryRegime(snap(10), cfg)).toBe("range")
    expect(gridEntryRegime(snap(22), cfg)).toBe("neutral")
  })

  it("normalizes a misconfigured threshold pair so neutral stays reachable", () => {
    const bad = { adxTrendThreshold: 25, adxRangeThreshold: 29 } as unknown as BotConfig
    expect(gridEntryRegime(snap(22), bad)).toBe("neutral")
  })
})

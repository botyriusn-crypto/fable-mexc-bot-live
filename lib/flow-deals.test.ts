import { describe, it, expect } from "vitest"
import { mapBybitDeals } from "./bybit/public"
import { mapGateDeals } from "./gateio/public"
import { computeTakerFlow } from "./mexc/public"

describe("mapBybitDeals", () => {
  it("maps taker side Buy/Sell to Deal 1/2", () => {
    const deals = mapBybitDeals([
      { price: "100", size: "2", side: "Buy", time: "1750000000000" },
      { price: "101", size: "1", side: "Sell", time: "1750000001000" },
    ])
    expect(deals).toHaveLength(2)
    expect(deals[0]).toMatchObject({ price: 100, volume: 2, side: 1 })
    expect(deals[1]).toMatchObject({ price: 101, volume: 1, side: 2 })
    const flow = computeTakerFlow(deals)
    expect(flow.takerBuyVolume).toBe(200)
    expect(flow.takerSellVolume).toBe(101)
    expect(flow.cvd).toBe(99)
  })

  it("drops unknown sides and junk rows, [] for non-array", () => {
    const deals = mapBybitDeals([
      { price: "100", size: "1", side: "Buy", time: "1" },
      { price: "100", size: "1", side: "Unknown", time: "2" },
      { price: "0", size: "1", side: "Sell", time: "3" },
      { price: "100", size: "0", side: "Sell", time: "4" },
      null,
    ])
    expect(deals).toHaveLength(1)
    expect(deals[0].side).toBe(1)
    expect(mapBybitDeals(null as any)).toEqual([])
  })
})

describe("mapGateDeals", () => {
  it("derives side from signed size and skips internal fills", () => {
    const deals = mapGateDeals([
      { id: 1, create_time_ms: 1750000000000.123, contract: "BTC_USDT", size: 5, price: "100" },
      { id: 2, create_time: 1750000001, contract: "BTC_USDT", size: -3, price: "101" },
      { id: 3, create_time_ms: 1750000002000, contract: "BTC_USDT", size: 9, price: "102", is_internal: true },
    ])
    expect(deals).toHaveLength(2)
    expect(deals[0]).toMatchObject({ price: 100, volume: 5, side: 1 })
    expect(deals[1]).toMatchObject({ price: 101, volume: 3, side: 2 })
    const flow = computeTakerFlow(deals)
    expect(flow.cvd).toBe(500 - 303)
  })

  it("drops zero/NaN sizes and non-arrays", () => {
    const deals = mapGateDeals([
      { price: "100", size: 0 },
      { price: "100", size: "abc" },
      { price: "0", size: 2 },
    ])
    expect(deals).toEqual([])
    expect(mapGateDeals(undefined as any)).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { buildMexcStopLossRequest } from "./mexc/private"
import { buildBybitStopLossRequest } from "./bybit/private"
import { buildGateStopLossRequest } from "./gateio/private"

// These tests pin the exact request bodies the bot sends to each venue's
// native (exchange-side) reduce-only stop-loss endpoint. They cannot reach a
// live exchange, so they verify the two things a wrong stop would get wrong:
//   1. trigger DIRECTION — a long stop must fire when price FALLS, a short
//      stop when price RISES. Inverting this turns the safety net into an
//      instant self-inflicted close.
//   2. close SIDE / size sign — the reduce-only order must close the position
//      it protects (sell to close a long, buy to close a short), never open a
//      new/opposite one.

describe("MEXC native stop-loss request", () => {
  const base = { symbol: "BTC_USDT", triggerPrice: 50000, vol: 3, leverage: 10 }

  it("LONG stop: fires as price falls (triggerType 2) and closes the long (side 4)", () => {
    const req = buildMexcStopLossRequest({ ...base, positionSide: "long" })
    expect(req).toMatchObject({
      symbol: "BTC_USDT",
      triggerPrice: 50000,
      triggerType: 2, // price <= trigger
      side: 4, // close long
      orderType: 5, // market on trigger
      trend: 1,
      vol: 3,
      leverage: 10,
      openType: 1,
      priceProtect: "0",
    })
  })

  it("SHORT stop: fires as price rises (triggerType 1) and closes the short (side 2)", () => {
    const req = buildMexcStopLossRequest({ ...base, positionSide: "short" })
    expect(req).toMatchObject({
      triggerType: 1, // price >= trigger
      side: 2, // close short
      orderType: 5,
    })
  })
})

describe("Bybit native stop-loss request", () => {
  it("sets the position-attached stop as a stringified price under Full tpslMode, one-way mode", () => {
    const req = buildBybitStopLossRequest({ symbol: "BTCUSDT", stopPrice: 50000 })
    expect(req).toEqual({
      category: "linear",
      symbol: "BTCUSDT",
      stopLoss: "50000",
      slTriggerBy: "MarkPrice",
      tpslMode: "Full",
      positionIdx: 0,
    })
  })

  it("stringifies fractional prices exactly", () => {
    const req = buildBybitStopLossRequest({ symbol: "ETHUSDT", stopPrice: 2543.21 })
    expect(req.stopLoss).toBe("2543.21")
  })
})

describe("Gate.io native stop-loss request", () => {
  it("LONG stop: fires as price falls (rule 2) and closes the long with a negative (sell) size", () => {
    const req = buildGateStopLossRequest({
      symbol: "BTC_USDT",
      positionSide: "long",
      triggerPrice: 50000,
      contracts: 4,
    }) as { initial: Record<string, unknown>; trigger: Record<string, unknown> }
    expect(req.initial).toMatchObject({
      contract: "BTC_USDT",
      size: -4, // negative = sell = close long
      price: "0",
      tif: "ioc",
      reduce_only: true,
    })
    expect(req.trigger).toMatchObject({
      strategy_type: 0,
      price_type: 0,
      price: "50000",
      rule: 2, // price <= trigger
    })
  })

  it("SHORT stop: fires as price rises (rule 1) and closes the short with a positive (buy) size", () => {
    const req = buildGateStopLossRequest({
      symbol: "BTC_USDT",
      positionSide: "short",
      triggerPrice: 50000,
      contracts: 4,
    }) as { initial: Record<string, unknown>; trigger: Record<string, unknown> }
    expect(req.initial).toMatchObject({
      size: 4, // positive = buy = close short
      reduce_only: true,
    })
    expect(req.trigger).toMatchObject({
      rule: 1, // price >= trigger
      price: "50000",
    })
  })
})

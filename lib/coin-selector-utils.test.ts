import { describe, expect, it } from "vitest"
import {
  buildAddPairPayload,
  buildMarketUrl,
  exchangeLabel,
  excludeMarkets,
  filterMarkets,
  findMarket,
  isSymbolAvailable,
  normalizeExchange,
  type CoinMarket,
} from "./coin-selector-utils"

const markets: CoinMarket[] = [
  { symbol: "BTC_USDT", displayName: "BTC/USDT", maxLeverage: 100 },
  { symbol: "ETH_USDT", displayName: "ETH/USDT", maxLeverage: 100 },
  { symbol: "SOL_USDT", displayName: "SOL/USDT", maxLeverage: 50 },
]

describe("coin-selector-utils", () => {
  it("keys the market URL by exchange so a switch refetches", () => {
    expect(buildMarketUrl("mexc")).toBe("/api/bot/market?exchange=mexc")
    expect(buildMarketUrl("gate")).toBe("/api/bot/market?exchange=gate")
    expect(buildMarketUrl("bybit")).toBe("/api/bot/market?exchange=bybit")
    expect(buildMarketUrl("mexc")).not.toBe(buildMarketUrl("gate"))
  })

  it("normalizes unknown exchanges to mexc", () => {
    expect(normalizeExchange("GATE")).toBe("gate")
    expect(normalizeExchange("bogus")).toBe("mexc")
    expect(normalizeExchange(undefined)).toBe("mexc")
  })

  it("labels known exchanges", () => {
    expect(exchangeLabel("mexc")).toBe("MEXC")
    expect(exchangeLabel("gate")).toBe("Gate.io")
    expect(exchangeLabel("bybit")).toBe("Bybit")
  })

  it("returns the complete list when the query is empty", () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      symbol: `COIN${i}_USDT`,
      displayName: `COIN${i}/USDT`,
      maxLeverage: 20,
    }))
    expect(filterMarkets(big, "")).toHaveLength(300)
    expect(filterMarkets(big, "   ")).toHaveLength(300)
  })

  it("filters case-insensitively on symbol and display name", () => {
    expect(filterMarkets(markets, "btc")).toHaveLength(1)
    expect(filterMarkets(markets, "ETH/USDT").map((m) => m.symbol)).toEqual(["ETH_USDT"])
    expect(filterMarkets(markets, "usdt")).toHaveLength(3)
    expect(filterMarkets(markets, "zzz")).toHaveLength(0)
  })

  it("excludes already-added symbols for the grid add picker", () => {
    expect(excludeMarkets(markets, []).map((m) => m.symbol)).toEqual([
      "BTC_USDT",
      "ETH_USDT",
      "SOL_USDT",
    ])
    expect(
      excludeMarkets(markets, ["btc_usdt", "SOL_USDT"]).map((m) => m.symbol),
    ).toEqual(["ETH_USDT"])
    expect(excludeMarkets(markets, ["BTC_USDT", "ETH_USDT", "SOL_USDT"])).toEqual([])
  })

  it("carries the header timeframe into the add-pair payload", () => {
    expect(buildAddPairPayload("BTC_USDT", "Min15")).toEqual({ symbol: "BTC_USDT", timeframe: "Min15" })
    expect(buildAddPairPayload("eth_usdt", "Hour4")).toEqual({ symbol: "ETH_USDT", timeframe: "Hour4" })
    expect(buildAddPairPayload("SOL_USDT", "Min60").timeframe).toBe("Min60")
  })

  it("detects whether the active symbol survives an exchange switch", () => {
    expect(isSymbolAvailable(markets, "btc_usdt")).toBe(true)
    expect(isSymbolAvailable(markets, "DOGE_USDT")).toBe(false)
    expect(isSymbolAvailable(undefined, "BTC_USDT")).toBe(false)
    expect(findMarket(markets, "sol_usdt")?.displayName).toBe("SOL/USDT")
  })
})

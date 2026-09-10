import { describe, it, expect } from "vitest"
import { detectFlashFade, flashFadeEntryAllowed } from "./flash-fade"
import type { Candle } from "./mexc/public"

const flat = (n: number, price = 100, vol = 10): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i, open: price, high: price + 1, low: price - 1, close: price, volume: vol,
  }))

describe("detectFlashFade", () => {
  it("goes long fading a -20% dump candle on 5x volume", () => {
    const candles = [...flat(29), {
      time: 29, open: 100, high: 101, low: 79, close: 80, volume: 50,
    }]
    const s = detectFlashFade(candles)
    expect(s.detected).toBe(true)
    expect(s.direction).toBe("long")
    expect(s.entryPrice).toBe(79)
    expect(s.takeProfit).toBe(100)
    expect(s.stopLoss).toBeLessThan(79)
  })

  it("goes short fading a +20% spike candle", () => {
    const candles = [...flat(29), {
      time: 29, open: 100, high: 121, low: 99, close: 120, volume: 50,
    }]
    const s = detectFlashFade(candles)
    expect(s.detected).toBe(true)
    expect(s.direction).toBe("short")
  })

  it("sits out below-threshold moves and thin volume", () => {
    const smallMove = [...flat(29), {
      time: 29, open: 100, high: 106, low: 99, close: 105, volume: 50,
    }]
    expect(detectFlashFade(smallMove).detected).toBe(false)
    const thinVol = [...flat(29), {
      time: 29, open: 100, high: 101, low: 79, close: 80, volume: 20,
    }]
    expect(detectFlashFade(thinVol).detected).toBe(false)
  })
})

describe("flashFadeEntryAllowed", () => {
  it("allows entry with no open flash positions", () => {
    expect(flashFadeEntryAllowed([], "BEAT_USDT", 2)).toBe(true)
  })

  it("blocks a second position on the same symbol", () => {
    expect(flashFadeEntryAllowed([{ symbol: "BEAT_USDT" }], "BEAT_USDT", 2)).toBe(false)
  })

  it("allows a different symbol under the cap", () => {
    expect(flashFadeEntryAllowed([{ symbol: "BEAT_USDT" }], "ENA_USDT", 2)).toBe(true)
  })

  it("blocks when total open positions hit maxPositions", () => {
    const open = [{ symbol: "BEAT_USDT" }, { symbol: "ENA_USDT" }]
    expect(flashFadeEntryAllowed(open, "SOL_USDT", 2)).toBe(false)
  })
})

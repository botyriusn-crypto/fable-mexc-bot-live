import { describe, expect, it } from "vitest"
import { runFlashFadeBacktest } from "./flashfade-backtest"
import type { Candle } from "./mexc/public"

const flat = (n: number, price = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 1000,
  }))

describe("runFlashFadeBacktest", () => {
  it("stays flat without spike bars", () => {
    const r = runFlashFadeBacktest("T", flat(200), { startEquity: 10000 })
    expect(r.trades).toHaveLength(0)
    expect(r.totalPnl).toBe(0)
  })

  it("fades a +25% volume-spike bar and books fees on both legs", () => {
    const candles = flat(120)
    // Spike bar: +25% close-to-close on 8x volume → short fade per detectFlashFade.
    candles[100] = { time: 100, open: 100, high: 126, low: 99, close: 125, volume: 8000 }
    const r = runFlashFadeBacktest("T", candles, { startEquity: 10000 })
    expect(r.trades.length).toBeGreaterThanOrEqual(1)
    const t = r.trades[0]
    expect(t.direction).toBe("short")
    expect(t.fees).toBeGreaterThan(0)
    // Fixed engine sizing: $300 margin @ 3x.
    expect(t.margin).toBe(300)
    expect(t.qty).toBeCloseTo((300 * 3) / t.entry, 10)
  })

  it("never stacks a second position on the same symbol", () => {
    const candles = flat(200)
    candles[100] = { time: 100, open: 100, high: 126, low: 99, close: 125, volume: 8000 }
    candles[101] = { time: 101, open: 125, high: 157, low: 124, close: 156, volume: 8000 }
    const r = runFlashFadeBacktest("T", candles, { startEquity: 10000, maxPositions: 2 })
    // At most one open at a time on the same symbol; count concurrent max.
    const concurrent = (bar: number) =>
      r.trades.filter((t) => t.bar <= bar && t.exitBar >= bar).length
    for (let b = 0; b < 200; b++) expect(concurrent(b)).toBeLessThanOrEqual(1)
  })
})

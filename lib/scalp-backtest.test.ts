import { describe, expect, it } from "vitest"
import { runScalpBacktest, type ScalpBacktestConfig } from "./scalp-backtest"
import { uptrendPullbackResume, chop } from "./test-candles"

const CFG: ScalpBacktestConfig = {
  startEquity: 10000,
  leverage: 10,
  riskPct: 0.01,
  positionBudgetUsdt: 500,
  feeBpsPerSide: 2,
  maxHoldBars: 48,
  warmupBars: 45,
  windowBars: 200,
  scalp: {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    atrPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    allowLong: true,
    allowShort: true,
    slAtrMult: 1.5,
  },
}

/** Proven trigger shape plus continued drift so the trade can exit. */
function trendWithExit(): Candle[] {
  const out = uptrendPullbackResume()
  let p = out[out.length - 1].close
  let time = out[out.length - 1].time
  for (let k = 0; k < 30; k++) {
    const open = p
    p = p * 1.004
    time += 3600_000
    out.push({ time, open, high: p * 1.0015, low: open * 0.999, close: p, volume: 1000 })
  }
  return out
}

describe("scalp-backtest", () => {
  it("trades a trend-with-exit series with consistent accounting", () => {
    const r = runScalpBacktest("TEST_USDT", trendWithExit(), CFG)
    expect(r.trades.length).toBeGreaterThanOrEqual(1)
    expect(r.wins + r.losses).toBe(r.trades.length)
    const sum = r.trades.reduce((s, x) => s + x.pnl, 0)
    expect(r.totalPnl).toBeCloseTo(sum, 6)
    expect(r.returnPct).toBeCloseTo((sum / CFG.startEquity) * 100, 6)
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(0)
    for (const tr of r.trades) {
      expect(tr.qty).toBeGreaterThan(0)
      expect(tr.margin).toBeLessThanOrEqual(CFG.positionBudgetUsdt + 1e-9)
      if (tr.direction === "long") {
        expect(tr.stop).toBeLessThan(tr.entry)
        expect(tr.take).toBeGreaterThan(tr.entry)
      } else {
        expect(tr.stop).toBeGreaterThan(tr.entry)
        expect(tr.take).toBeLessThan(tr.entry)
      }
    }
  })

  it("stays flat in chop", () => {
    const r = runScalpBacktest("CHOP_USDT", chop(150), CFG)
    expect(r.trades.length).toBe(0)
    expect(r.totalPnl).toBe(0)
  })
})

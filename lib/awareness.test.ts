import { describe, expect, it } from "vitest"
import { decide, type AwarenessState } from "./awareness"
import type { ScalpSignal } from "./trend-scalper"

const scalpOn = (over: Partial<ScalpSignal> = {}): ScalpSignal =>
  ({
    direction: "long",
    triggered: true,
    confidence: 0.6,
    reason: "test",
    stopLoss: 99,
    takeProfit: 103,
    atr: 1,
    suggestedSizeUsdt: 100,
    rMultiple: 1.8,
    filters: { adxOk: true, volatilityOk: true, trendAligned: true, pulledBack: true, resuming: true },
    ...over,
  }) as ScalpSignal

const scalpOff: ScalpSignal = { ...scalpOn(), triggered: false, direction: null, confidence: 0 }

const base = (over: Partial<AwarenessState> = {}): AwarenessState => ({
  symbol: "BTC_USDT",
  timeframe: "15",
  regime: "neutral",
  trendThreshold: 25,
  rangeThreshold: 20,
  trend: "none",
  trendStrength: 0,
  atr: 1,
  mlConfidence: 0.5,
  logisticConfidence: 0.5,
  lorentzianConfidence: null,
  mlAllowed: true,
  scalp: null,
  gridNetExposure: 0,
  gridAvgEntry: null,
  gridUnrealizedPnl: 0,
  exposurePct: 0,
  marginRemaining: 1e9,
  killSwitch: false,
  ...over,
})

describe("decide", () => {
  it("defers a range-regime scalp to grid mean-reversion (neutral gate)", () => {
    const d = decide(base({ regime: "range", scalp: scalpOn() }))
    expect(d).toEqual({ action: "grid-mean-revert" })
  })

  it("trades a triggered ML-allowed scalp in NEUTRAL regime", () => {
    const d = decide(base({ regime: "neutral", scalp: scalpOn({ direction: "short" }) }))
    expect(d).toEqual({ action: "scalp-trend", direction: "short", confidence: 0.6 })
  })

  it("stands aside with an honest reason for a trend-regime scalp (neutral gate)", () => {
    const d = decide(base({ regime: "trend", scalp: scalpOn() }))
    expect(d).toEqual({ action: "stand-aside", reason: "scalp requires neutral regime (in trend)" })
  })

  it("still trails profitable aligned inventory before a fresh scalp in trend", () => {
    const d = decide(
      base({
        regime: "trend",
        trend: "long",
        scalp: scalpOn(),
        gridNetExposure: 2,
        gridAvgEntry: 100,
        gridUnrealizedPnl: 5, // > 1R = 1 * (2/100) = 0.02
      }),
    )
    expect(d).toEqual({ action: "trail-inventory", direction: "long" })
  })

  it("stands aside in trend without a scalp setup (unchanged reason)", () => {
    const d = decide(base({ regime: "trend", scalp: scalpOff }))
    expect(d).toEqual({ action: "stand-aside", reason: "trend but no scalp setup" })
  })

  it("falls back to grid mean-reversion in range without a scalp (unchanged)", () => {
    const d = decide(base({ regime: "range", scalp: scalpOff }))
    expect(d).toEqual({ action: "grid-mean-revert" })
  })

  it("risk gate still wins over everything", () => {
    const d = decide(base({ regime: "trend", scalp: scalpOn(), killSwitch: true }))
    expect(d).toEqual({ action: "stand-aside", reason: "risk gate" })
  })

  it("names the ML veto instead of a regime call when ML rejects", () => {
    const d = decide(base({ regime: "trend", mlAllowed: false, scalp: scalpOn() }))
    expect(d).toEqual({ action: "stand-aside", reason: "ml gate rejected scalp setup" })
    const e = decide(base({ regime: "neutral", mlAllowed: false, scalp: scalpOn() }))
    expect(e).toEqual({ action: "stand-aside", reason: "ml gate rejected scalp setup" })
  })
})

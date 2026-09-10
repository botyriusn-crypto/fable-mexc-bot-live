import { describe, it, expect } from "vitest"
import type { Candle } from "./mexc/public"
import { computeSnapshot } from "./indicators"
import { notionalToMarginUsdt } from "./strategy"
import { evaluateScalpSignal, macdTurnedUp, SCALP } from "./trend-scalper"

// Minimal config matching the fields the scalper + computeSnapshot read.
const cfg: any = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  atrPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  allowLong: true,
  allowShort: true,
  leverage: 10,
  slAtrMult: 1.5,
  positionSizeUsdt: 50,
}

// Shared deterministic builders (see lib/test-candles.ts).
import { uptrendPullbackResume, chop } from "./test-candles"

describe("evaluateScalpSignal", () => {
  it("fires a long on a clean uptrend pullback-resume setup", () => {
    const candles = uptrendPullbackResume()
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    // Diagnostic output surfaces the exact failing filter if this ever breaks.
    console.log("uptrend signal:", JSON.stringify({ reason: sig.reason, adx: snap.adx, atrPct: snap.atr / snap.price, roc: snap.roc, volSurge: snap.volSurge, rsi: snap.rsi, filters: sig.filters, confidence: sig.confidence }))
    expect(sig.triggered).toBe(true)
    expect(sig.direction).toBe("long")
    expect(sig.stopLoss).not.toBeNull()
    expect(sig.takeProfit).not.toBeNull()
    expect(sig.stopLoss!).toBeLessThan(snap.price)
    expect(sig.takeProfit!).toBeGreaterThan(snap.price)
    // R:R must respect configured multiple (within rounding)
    const risk = snap.price - sig.stopLoss!
    const reward = sig.takeProfit! - snap.price
    expect(reward / risk).toBeGreaterThan(1.5)
  })

  it("stays silent in tight chop (low ADX / low volatility)", () => {
    const candles = chop()
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    console.log("chop signal:", JSON.stringify({ reason: sig.reason, adx: snap.adx, atrPct: snap.atr / snap.price }))
    expect(sig.triggered).toBe(false)
    expect(sig.direction).toBeNull()
  })

  it("accepts a MACD turn on the previous bar, rejects older turns", () => {
    // Long side: turn on this bar, turn on previous bar, no recent turn.
    expect(macdTurnedUp([0, -2, -1], 1)).toBe(true)
    expect(macdTurnedUp([0, 1, 0.5], 1)).toBe(true)
    expect(macdTurnedUp([2, 1, 0], 1)).toBe(false)
    // Short side mirrors.
    expect(macdTurnedUp([0, 2, 1], -1)).toBe(true)
    expect(macdTurnedUp([0, -1, -0.5], -1)).toBe(true)
    expect(macdTurnedUp([-2, -1, 0], -1)).toBe(false)
    // Too short to judge.
    expect(macdTurnedUp([1, 2], 1)).toBe(false)
  })

  it("resumes on a directional bar even when it doesn't exceed the prior close", () => {
    // Lift the previous close a touch above the trigger bar's close: the
    // trigger bar itself is untouched (still green, MACD turning), so the
    // only thing the old vs-prev clause could object to is gone with it.
    const candles = uptrendPullbackResume()
    const lastClose = candles[candles.length - 1].close
    const prev = candles[candles.length - 2]
    const lifted = lastClose * 1.002
    candles[candles.length - 2] = {
      ...prev,
      high: Math.max(prev.high, lifted * 1.001),
      close: lifted,
    }
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 10000)
    expect(sig.filters.resuming).toBe(true)
    expect(sig.direction).toBe("long")
  })

  it("defaults the volatility ceiling to 10% (ATR risk is priced by sizing)", () => {
    delete process.env.SCALP_ATRPCT_MAX
    expect(SCALP.atrPctMax()).toBe(0.1)
    expect(SCALP.atrPctMin()).toBe(0.0015)
  })

  it("defaults the confluence threshold to 0.5 (measured 1-3% setup rate)", () => {
    delete process.env.SCALP_SCORE_THRESHOLD
    expect(SCALP.scoreThreshold()).toBe(0.5)
  })

  it("stays silent when there is insufficient data", () => {
    const candles = uptrendPullbackResume().slice(-10)
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    expect(sig.triggered).toBe(false)
  })

  it("converts risk notional to margin without leverage inflation", () => {
    expect(notionalToMarginUsdt(1000, 10)).toBe(100)
    expect(notionalToMarginUsdt(1000, 1)).toBe(1000)
    expect(notionalToMarginUsdt(0, 10)).toBe(0)
    expect(notionalToMarginUsdt(-50, 10)).toBe(0)
    expect(notionalToMarginUsdt(1000, 0)).toBe(1000)
  })

  it("risks at most 1% of equity at 10x after margin conversion", () => {
    const candles = uptrendPullbackResume()
    const snap = computeSnapshot(candles, cfg)
    const equity = 10000
    const sig = evaluateScalpSignal(snap, candles, cfg, equity)
    expect(sig.triggered).toBe(true)
    expect(sig.suggestedSizeUsdt).not.toBeNull()
    expect(sig.stopLoss).not.toBeNull()
    // What the engine actually risks now that the notional is booked as margin:
    const margin = notionalToMarginUsdt(sig.suggestedSizeUsdt!, cfg.leverage)
    const stopDist = snap.price - sig.stopLoss!
    const stopFrac = stopDist / snap.price
    const actualRisk = margin * cfg.leverage * stopFrac
    // Safety property: realized risk never exceeds the configured 1% × confidence.
    // (The Kelly cap can only push it lower.)
    expect(actualRisk).toBeLessThanOrEqual(equity * 0.01 * sig.confidence + 0.5)
    // Composition check: margin booking preserves the sizing math exactly.
    // (sizing assumes a 1.5×ATR stop; the capped notional × confidence × the
    // actual stop fraction is what the account really risks.)
    const uncapped = (equity * 0.01) / ((1.5 * sig.atr) / snap.price)
    const expected = Math.min(uncapped, equity * 0.25) * sig.confidence * stopFrac
    expect(actualRisk).toBeCloseTo(expected, 0)
    // Pre-fix behavior booked the raw notional as margin, so the engine
    // multiplied by leverage again — exactly leverage× the realized risk.
    const prefixRisk = sig.suggestedSizeUsdt! * cfg.leverage * stopFrac
    expect(prefixRisk / actualRisk).toBeCloseTo(cfg.leverage, 0)
  })
})

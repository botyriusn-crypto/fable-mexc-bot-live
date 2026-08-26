import { describe, it, expect } from "vitest"
import type { Candle } from "./mexc/public"
import { computeSnapshot } from "./indicators"
import { evaluateScalpSignal } from "./trend-scalper"

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

// Seeded RNG (mulberry32) so tests are deterministic.
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const t = 1_700_000_000_000
// Build a candle from open/close with realistic two-sided wicks (so ADX and ATR
// behave like a real market rather than maxing out on perfectly clean moves).
function mkCandle(i: number, open: number, close: number, wickFrac: number, volume: number): Candle {
  const body = Math.max(open, close)
  const bodyLow = Math.min(open, close)
  const high = body * (1 + wickFrac)
  const low = bodyLow * (1 - wickFrac)
  return { time: t + i * 60_000, open, high, low, close, volume }
}

// A noisy uptrend (net drift up, but many red candles → moderate ADX), then a
// clean multi-candle pullback into the fast EMA, then a strong green resumption
// candle on higher volume.
function uptrendPullbackResume(): Candle[] {
  const r = rng(42)
  const out: Candle[] = []
  let p = 100
  let i = 0
  // 44 noisy rising candles: +0.4% drift with ±0.6% noise
  for (; i < 44; i++) {
    const open = p
    const drift = 0.0035
    const noise = (r() - 0.5) * 0.026
    p = p * (1 + drift + noise)
    out.push(mkCandle(i, open, p, 0.0015 + r() * 0.004, 1000 + Math.floor(r() * 200)))
  }
  // 4-candle clean pullback (~0.8% down each) on rising volume
  for (let k = 0; k < 4; k++, i++) {
    const open = p
    p = p * (1 - 0.008)
    out.push(mkCandle(i, open, p, 0.001 + r() * 0.002, 1400))
  }
  // strong green resumption candle on a clear volume surge
  {
    const open = p
    p = p * (1 + 0.028)
    out.push(mkCandle(i, open, p, 0.0015, 3200))
  }
  return out
}

// Tight, directionless chop: net-zero drift with symmetric noise → low ADX.
function chop(): Candle[] {
  const r = rng(7)
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < 60; i++) {
    const open = p
    const noise = (r() - 0.5) * 0.006 // ±0.3%, no drift
    p = p * (1 + noise)
    out.push(mkCandle(i, open, p, 0.001 + r() * 0.002, 1000))
  }
  return out
}

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

  it("stays silent when there is insufficient data", () => {
    const candles = uptrendPullbackResume().slice(-10)
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    expect(sig.triggered).toBe(false)
  })
})

// Shared deterministic candle builders for tests. Seeded RNG (mulberry32)
// keeps every consumer's series identical across runs.
import type { Candle } from "./mexc/public"

export function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export const T0 = 1_700_000_000_000

// Build a candle from open/close with realistic two-sided wicks (so ADX and ATR
// behave like a real market rather than maxing out on perfectly clean moves).
export function mkCandle(
  time: number,
  open: number,
  close: number,
  wickFrac: number,
  volume: number,
): Candle {
  const body = Math.max(open, close)
  const bodyLow = Math.min(open, close)
  const high = body * (1 + wickFrac)
  const low = bodyLow * (1 - wickFrac)
  return { time, open, high, low, close, volume }
}

// A noisy uptrend (net drift up, but many red candles → moderate ADX), then a
// clean multi-candle pullback into the fast EMA, then a strong green resumption
// candle on higher volume.
export function uptrendPullbackResume(): Candle[] {
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
    out.push(mkCandle(T0 + i * 60_000, open, p, 0.0015 + r() * 0.004, 1000 + Math.floor(r() * 200)))
  }
  // 4-candle clean pullback (~0.8% down each) on rising volume
  for (let k = 0; k < 4; k++, i++) {
    const open = p
    p = p * (1 - 0.008)
    out.push(mkCandle(T0 + i * 60_000, open, p, 0.001 + r() * 0.002, 1400))
  }
  // strong green resumption candle on a clear volume surge
  {
    const open = p
    p = p * (1 + 0.028)
    out.push(mkCandle(T0 + i * 60_000, open, p, 0.0015, 3200))
  }
  return out
}

// Tight, directionless chop: net-zero drift with symmetric noise → low ADX.
export function chop(n = 60): Candle[] {
  const r = rng(7)
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const open = p
    const noise = (r() - 0.5) * 0.006 // ±0.3%, no drift
    p = p * (1 + noise)
    out.push(mkCandle(T0 + i * 60_000, open, p, 0.001 + r() * 0.002, 1000))
  }
  return out
}

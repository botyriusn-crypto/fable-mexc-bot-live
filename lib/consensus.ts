// Bitsgap-style multi-indicator consensus rating.
// Each indicator votes Buy=1 / Neutral=0 / Sell=-1; the average maps to
// Strong Buy / Buy / Neutral / Sell / Strong Sell.
// USAGE IN THIS BOT: observability + grid pause tightening ONLY.
// Consensus extremes mean "trending" — grids must PAUSE, not enter.
import type { Candle } from "./mexc/public"
import { ema, rsi, rateOfChange, adx, bollinger } from "./indicators"

export type ConsensusBucket = "strong-buy" | "buy" | "neutral" | "sell" | "strong-sell"

export interface ConsensusResult {
  score: number
  bucket: ConsensusBucket
  buy: number
  sell: number
  neutral: number
  total: number
}

function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    out[i] = i >= period - 1 ? sum / period : values[i]
  }
  return out
}

function stochastic(candles: Candle[], period = 14, sk = 3, sd = 3): { k: number[]; d: number[] } {
  const raw: number[] = new Array(candles.length).fill(50)
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity
    for (let j = i - period + 1; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low) }
    raw[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100
  }
  return { k: sma(raw, sk), d: sma(raw, sk * sd) }
}

function cci(candles: Candle[], period = 20): number[] {
  const out: number[] = new Array(candles.length).fill(0)
  const tp = candles.map(c => (c.high + c.low + c.close) / 3)
  for (let i = period - 1; i < candles.length; i++) {
    const slice = tp.slice(i - period + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const md = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period
    out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md)
  }
  return out
}

function williamsR(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(-50)
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity
    for (let j = i - period + 1; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low) }
    out[i] = hh === ll ? -50 : ((hh - candles[i].close) / (hh - ll)) * -100
  }
  return out
}

function macdMainSignal(closes: number[]): { main: number[]; signal: number[] } {
  const e12 = ema(closes, 12), e26 = ema(closes, 26)
  const main = e12.map((v, i) => v - e26[i])
  return { main, signal: ema(main, 9) }
}

function directional(candles: Candle[], period = 14): { plusDI: number[]; minusDI: number[] } {
  const len = candles.length
  const plusDI: number[] = new Array(len).fill(0)
  const minusDI: number[] = new Array(len).fill(0)
  let smTR = 0, smPlus = 0, smMinus = 0
  for (let i = 1; i < len; i++) {
    const c = candles[i], p = candles[i - 1]
    const up = c.high - p.high, down = p.low - c.low
    const plusDM = up > down && up > 0 ? up : 0
    const minusDM = down > up && down > 0 ? down : 0
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    if (i <= period) { smTR += tr; smPlus += plusDM; smMinus += minusDM; continue }
    smTR = smTR - smTR / period + tr
    smPlus = smPlus - smPlus / period + plusDM
    smMinus = smMinus - smMinus / period + minusDM
    plusDI[i] = smTR === 0 ? 0 : (smPlus / smTR) * 100
    minusDI[i] = smTR === 0 ? 0 : (smMinus / smTR) * 100
  }
  return { plusDI, minusDI }
}

export function computeConsensus(candles: Candle[]): ConsensusResult {
  const i = candles.length - 1
  const closes = candles.map(c => c.close)
  const price = closes[i]
  const s: number[] = []

  // Moving-average stack (trend votes): MA below price = Buy
  for (const p of [10, 20, 30, 50, 100, 200]) {
    const e = ema(closes, p)[i], m = sma(closes, p)[i]
    s.push(e < price ? 1 : e > price ? -1 : 0)
    s.push(m < price ? 1 : m > price ? -1 : 0)
  }

  // Oscillators (mean-reversion votes, per Bitsgap spec)
  const r = rsi(closes, 14)
  s.push(r[i] < 30 && r[i] >= r[i - 1] ? 1 : r[i] > 70 && r[i] <= r[i - 1] ? -1 : 0)

  const st = stochastic(candles)
  s.push(st.k[i] < 20 && st.d[i] < 20 ? 1 : st.k[i] > 80 && st.d[i] > 80 ? -1 : 0)

  const c = cci(candles)
  s.push(c[i] < -100 && c[i] >= c[i - 1] ? 1 : c[i] > 100 && c[i] <= c[i - 1] ? -1 : 0)

  const w = williamsR(candles)
  s.push(w[i] < -80 && w[i] >= w[i - 1] ? 1 : w[i] > -20 && w[i] <= w[i - 1] ? -1 : 0)

  const mc = macdMainSignal(closes)
  s.push(mc.main[i] > 0 && mc.signal[i] > 0 && mc.main[i] > mc.signal[i] ? 1
    : mc.main[i] < 0 && mc.signal[i] < 0 && mc.main[i] < mc.signal[i] ? -1 : 0)

  const mom = rateOfChange(closes, 10)
  s.push(mom[i] > mom[i - 1] ? 1 : mom[i] < mom[i - 1] ? -1 : 0)

  const bb = bollinger(closes, 20, 2)
  s.push(price > bb.upper ? 1 : price < bb.lower ? -1 : 0)

  const di = directional(candles)
  const adxArr = adx(candles, 14)
  s.push(adxArr[i] > 20 ? (di.plusDI[i] > di.minusDI[i] ? 1 : -1) : 0)

  const score = s.reduce((a, b) => a + b, 0) / s.length
  const bucket: ConsensusBucket =
    score > 0.5 ? "strong-buy" : score > 0.1 ? "buy" : score >= -0.1 ? "neutral" : score >= -0.5 ? "sell" : "strong-sell"

  return {
    score,
    bucket,
    buy: s.filter(v => v > 0).length,
    sell: s.filter(v => v < 0).length,
    neutral: s.filter(v => v === 0).length,
    total: s.length,
  }
}

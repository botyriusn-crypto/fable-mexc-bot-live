// Technical indicator + feature vector computation (pure TypeScript)

import type { Candle } from "./mexc/public"

export interface FeatureVector {
  emaSpread: number // (emaFast - emaSlow) / price, normalized
  crossover: number // 1 = bullish cross, -1 = bearish cross, 0 = none
  rsi: number // normalized to [-1, 1] around 50
  macdHist: number // MACD histogram / price, scaled
  atrPct: number // ATR as % of price, scaled
  roc: number // rate of change, scaled
  adx: number // trend strength normalized [0, 1]
  volSurge: number // volume surge ratio - 1, clamped
  sideLong: number // 1 for long candidate, -1 for short (set by strategy)
}

export interface IndicatorSnapshot {
  price: number
  emaFast: number
  emaSlow: number
  prevEmaFast: number
  prevEmaSlow: number
  rsi: number
  macdHist: number
  atr: number
  roc: number
  adx: number
  volSurge: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  features: Omit<FeatureVector, "sideLong">
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      out[i] = 50
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    }
  }
  return out
}

export function macdHistogram(closes: number[]): number[] {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signal = ema(macdLine, 9)
  return macdLine.map((v, i) => v - signal[i])
}

export function atr(candles: Candle[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(0)
  let prev = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = i > 0 ? candles[i - 1].close : c.close
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    )
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period
    out[i] = prev
  }
  return out
}

export function rateOfChange(closes: number[], period = 10): number[] {
  return closes.map((c, i) =>
    i < period ? 0 : ((c - closes[i - period]) / closes[i - period]) * 100,
  )
}

// Simplified ADX (Wilder's smoothing)
export function adx(candles: Candle[], period = 14): number[] {
  const len = candles.length
  const out: number[] = new Array(len).fill(0)
  if (len < period * 2) return out

  let smTR = 0
  let smPlusDM = 0
  let smMinusDM = 0
  let adxVal = 0
  const dxs: number[] = []

  for (let i = 1; i < len; i++) {
    const c = candles[i]
    const p = candles[i - 1]
    const upMove = c.high - p.high
    const downMove = p.low - c.low
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    )

    if (i <= period) {
      smTR += tr
      smPlusDM += plusDM
      smMinusDM += minusDM
      continue
    }

    smTR = smTR - smTR / period + tr
    smPlusDM = smPlusDM - smPlusDM / period + plusDM
    smMinusDM = smMinusDM - smMinusDM / period + minusDM

    const plusDI = smTR === 0 ? 0 : (smPlusDM / smTR) * 100
    const minusDI = smTR === 0 ? 0 : (smMinusDM / smTR) * 100
    const dx =
      plusDI + minusDI === 0
        ? 0
        : (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100
    dxs.push(dx)

    if (dxs.length === period) {
      adxVal = dxs.reduce((a, b) => a + b, 0) / period
    } else if (dxs.length > period) {
      adxVal = (adxVal * (period - 1) + dx) / period
    }
    out[i] = adxVal
  }
  return out
}

export function bollinger(
  closes: number[],
  period: number,
  stdMult: number,
): { upper: number; middle: number; lower: number; widthPct: number } {
  const i = closes.length - 1
  const start = Math.max(0, i - period + 1)
  const window = closes.slice(start, i + 1)
  const middle = window.reduce((a, b) => a + b, 0) / window.length
  const variance = window.reduce((a, b) => a + (b - middle) ** 2, 0) / window.length
  const std = Math.sqrt(variance)
  const upper = middle + std * stdMult
  const lower = middle - std * stdMult
  return { upper, middle, lower, widthPct: middle === 0 ? 0 : ((upper - lower) / middle) * 100 }
}

export function volumeSurge(candles: Candle[], lookback = 20): number[] {
  return candles.map((c, i) => {
    if (i < lookback) return 1
    let sum = 0
    for (let j = i - lookback; j < i; j++) sum += candles[j].volume
    const avg = sum / lookback
    return avg === 0 ? 1 : c.volume / avg
  })
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))

export function computeSnapshot(
  candles: Candle[],
  cfg: {
    emaFast: number
    emaSlow: number
    rsiPeriod: number
    atrPeriod: number
    bbPeriod?: number
    bbStd?: number
  },
): IndicatorSnapshot {
  const closes = candles.map((c) => c.close)
  const i = candles.length - 1

  const emaF = ema(closes, cfg.emaFast)
  const emaS = ema(closes, cfg.emaSlow)
  const rsiArr = rsi(closes, cfg.rsiPeriod)
  const macdArr = macdHistogram(closes)
  const atrArr = atr(candles, cfg.atrPeriod)
  const rocArr = rateOfChange(closes)
  const adxArr = adx(candles)
  const volArr = volumeSurge(candles)
  const bb = bollinger(closes, cfg.bbPeriod ?? 20, cfg.bbStd ?? 2)

  const price = closes[i]

  const features = {
    emaSpread: clamp(((emaF[i] - emaS[i]) / price) * 100, -3, 3) / 3,
    crossover:
      emaF[i - 1] <= emaS[i - 1] && emaF[i] > emaS[i]
        ? 1
        : emaF[i - 1] >= emaS[i - 1] && emaF[i] < emaS[i]
          ? -1
          : 0,
    rsi: clamp((rsiArr[i] - 50) / 50, -1, 1),
    macdHist: clamp((macdArr[i] / price) * 1000, -3, 3) / 3,
    atrPct: clamp((atrArr[i] / price) * 100, 0, 5) / 5,
    roc: clamp(rocArr[i] / 5, -1, 1),
    adx: clamp(adxArr[i] / 50, 0, 1),
    volSurge: clamp(volArr[i] - 1, -1, 3) / 3,
  }

  return {
    price,
    emaFast: emaF[i],
    emaSlow: emaS[i],
    prevEmaFast: emaF[i - 1],
    prevEmaSlow: emaS[i - 1],
    rsi: rsiArr[i],
    macdHist: macdArr[i],
    atr: atrArr[i],
    roc: rocArr[i],
    adx: adxArr[i],
    volSurge: volArr[i],
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    features,
  }
}

// Composite momentum score in [0, 1] — used for hype detection.
// direction: 1 for long positions, -1 for short.
export function vwap(candles: Candle[]): number {
  if (candles.length === 0) return 0
  let cumulativeTPV = 0
  let cumulativeVolume = 0
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3
    const volume = c.volume || 0
    cumulativeTPV += typicalPrice * volume
    cumulativeVolume += volume
  }
  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0
}

export function marketStructure(candles: Candle[], lookback: number = 20): { higherHighs: boolean, higherLows: boolean, lowerHighs: boolean, lowerLows: boolean } {
  if (candles.length < lookback) return { higherHighs: false, higherLows: false, lowerHighs: false, lowerLows: false }
  const slice = candles.slice(-lookback)
  const highs = slice.map(c => c.high)
  const lows = slice.map(c => c.low)
  const swingHighs: number[] = []
  const swingLows: number[] = []
  for (let i = 2; i < slice.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) swingHighs.push(highs[i])
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) swingLows.push(lows[i])
  }
  const last3Highs = swingHighs.slice(-3)
  const last3Lows = swingLows.slice(-3)
  return {
    higherHighs: last3Highs.length >= 2 && last3Highs[last3Highs.length-1] > last3Highs[last3Highs.length-2],
    higherLows: last3Lows.length >= 2 && last3Lows[last3Lows.length-1] > last3Lows[last3Lows.length-2],
    lowerHighs: last3Highs.length >= 2 && last3Highs[last3Highs.length-1] < last3Highs[last3Highs.length-2],
    lowerLows: last3Lows.length >= 2 && last3Lows[last3Lows.length-1] < last3Lows[last3Lows.length-2]
  }
}

export function volumeConfirmation(candles: Candle[], threshold: number = 1.5): boolean {
  if (candles.length < 20) return false
  const recent = candles.slice(-5)
  const older = candles.slice(-20, -5)
  const avgRecentVolume = recent.reduce((s, c) => s + (c.volume || 0), 0) / recent.length
  const avgOlderVolume = older.reduce((s, c) => s + (c.volume || 0), 0) / older.length
  return avgOlderVolume > 0 && (avgRecentVolume / avgOlderVolume) >= threshold
}

export function momentumScore(snap: IndicatorSnapshot, direction: 1 | -1): number {
  const rocComponent = clamp((snap.roc * direction) / 3, 0, 1) // strong directional ROC
  const volComponent = clamp((snap.volSurge - 1) / 2, 0, 1) // volume surge above average
  const adxComponent = clamp((snap.adx - 20) / 30, 0, 1) // trending market
  return rocComponent * 0.45 + volComponent * 0.3 + adxComponent * 0.25
}

// Get features from candles with validation. Returns all 9 features as a Record.
// Validates that features are sane (not NaN, in reasonable range).
export async function getFeatures(
  candles: Candle[],
  cfg: {
    emaFast?: number
    emaSlow?: number
    rsiPeriod?: number
    atrPeriod?: number
  } = {},
): Promise<Record<string, number>> {
  if (!candles || candles.length < 50) {
    // Not enough candles; return neutral features
    return {
      emaSpread: 0,
      crossover: 0,
      rsi: 0,
      macdHist: 0,
      atrPct: 0,
      roc: 0,
      adx: 0,
      volSurge: 0,
      sideLong: 0,
    }
  }

  try {
    const snap = computeSnapshot(candles, {
      emaFast: cfg.emaFast ?? 9,
      emaSlow: cfg.emaSlow ?? 21,
      rsiPeriod: cfg.rsiPeriod ?? 14,
      atrPeriod: cfg.atrPeriod ?? 14,
    })

    // Determine sideLong: 1 if fast EMA above slow EMA (bullish), -1 otherwise
    const sideLong = snap.emaFast > snap.emaSlow ? 1 : -1

    const features: Record<string, number> = {
      emaSpread: snap.features.emaSpread,
      crossover: snap.features.crossover,
      rsi: snap.features.rsi,
      macdHist: snap.features.macdHist,
      atrPct: snap.features.atrPct,
      roc: snap.features.roc,
      adx: snap.features.adx,
      volSurge: snap.features.volSurge,
      sideLong,
    }

    // Validate all features
    for (const [name, value] of Object.entries(features)) {
      if (!isFinite(value)) {
        console.warn(`[indicators] Feature ${name} is not finite (${value}), resetting to 0`)
        features[name] = 0
      }
    }

    return features
  } catch (err) {
    console.error(`[indicators] getFeatures failed:`, err)
    return {
      emaSpread: 0,
      crossover: 0,
      rsi: 0,
      macdHist: 0,
      atrPct: 0,
      roc: 0,
      adx: 0,
      volSurge: 0,
      sideLong: 0,
    }
  }
}

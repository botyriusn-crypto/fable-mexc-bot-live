// lib/indicators.ts
import { getCandles, type Candle } from "./mexc/public"

export interface Features {
  emaSpread: number
  crossover: number
  rsi: number
  macdHist: number
  atrPct: number
  roc: number
  adx: number
  volSurge: number
  sideLong: number
}

export function sma(candles: Candle[], period: number): number {
  const slice = candles.slice(-period)
  const sum = slice.reduce((a, c) => a + (c.close + c.open) / 2, 0)
  return sum / Math.max(1, slice.length)
}

export function ema(candles: Candle[], period: number): number {
  if (candles.length < period) return sma(candles, Math.min(candles.length, period))
  const k = 2 / (period + 1)
  let ema = candles[0].close
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k)
  }
  return ema
}

function emaFromArray(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let ema = values[0]
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
  }
  return ema
}

function smaArray(values: number[], period: number): number {
  if (values.length === 0) return 0
  const slice = values.slice(-Math.min(period, values.length))
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

export function rsi(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50
  
  // Calculate gains and losses
  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close
    gains.push(delta > 0 ? delta : 0)
    losses.push(delta < 0 ? -delta : 0)
  }
  
  // Initial averages (simple average of first 'period' values)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period
  
  // Wilder's smoothing for remaining values
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
  }
  
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function macd(candles: Candle[]): { line: number; signal: number; histogram: number } {
  const closes = candles.map(c => c.close)
  const fast = emaFromArray(closes, 12)
  const slow = emaFromArray(closes, 26)
  const line = fast - slow
  const macdSeries: number[] = []
  for (let i = 25; i < closes.length; i++) {
    const f = emaFromArray(closes.slice(0, i + 1), 12)
    const s = emaFromArray(closes.slice(0, i + 1), 26)
    macdSeries.push(f - s)
  }
  const signal = emaFromArray(macdSeries, 9)
  return { line, signal, histogram: line - signal }
}

export function atr(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0
  
  // Calculate TR series
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  
  if (trs.length === 0) return 0
  if (trs.length <= period) return trs.reduce((a, b) => a + b, 0) / trs.length
  
  // Initial ATR = simple average of first 'period' TR values
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  
  // Wilder's smoothing
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  
  return atr
}

export function roc(candles: Candle[], period: number = 12): number {
  if (candles.length < period) return 0
  const now = candles[candles.length - 1].close
  const past = candles[candles.length - 1 - period].close
  return past !== 0 ? ((now - past) / past) * 100 : 0
}

// ========== ADX — exact TradingView Pine Script logic ==========
export function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0
  
  const n = candles.length
  
  // Step 1: Calculate TR, DM+, DM- for each bar (starting from bar 1)
  const tr: number[] = []
  const dmPlus: number[] = []
  const dmMinus: number[] = []
  
  for (let i = 1; i < n; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevHigh = candles[i - 1].high
    const prevLow = candles[i - 1].low
    const prevClose = candles[i - 1].close
    
    // TrueRange
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
    
    // DirectionalMovement
    const up = high - prevHigh
    const down = prevLow - low
    
    if (up > down && up > 0) {
      dmPlus.push(up)
      dmMinus.push(0)
    } else if (down > up && down > 0) {
      dmPlus.push(0)
      dmMinus.push(down)
    } else {
      dmPlus.push(0)
      dmMinus.push(0)
    }
  }
  
  const m = tr.length // number of bars after first
  if (m < period) return 0
  
  // Step 2: Wilder's smoothing — running calculation
  // First smoothed value = SMA of first 'period' values
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  let smoothDMP = dmPlus.slice(0, period).reduce((a, b) => a + b, 0) / period
  let smoothDMM = dmMinus.slice(0, period).reduce((a, b) => a + b, 0) / period
  
  // Store smoothed values starting from index 'period-1'
  const smoothTRs: number[] = [smoothTR]
  const smoothDMPs: number[] = [smoothDMP]
  const smoothDMMs: number[] = [smoothDMM]
  
  // Wilder's: next = prev - (prev/period) + current
  for (let i = period; i < m; i++) {
    smoothTR = smoothTR - (smoothTR / period) + tr[i]
    smoothDMP = smoothDMP - (smoothDMP / period) + dmPlus[i]
    smoothDMM = smoothDMM - (smoothDMM / period) + dmMinus[i]
    smoothTRs.push(smoothTR)
    smoothDMPs.push(smoothDMP)
    smoothDMMs.push(smoothDMM)
  }
  
  // Step 3: Calculate DX for each smoothed point
  const dxValues: number[] = []
  for (let i = 0; i < smoothTRs.length; i++) {
    const trVal = smoothTRs[i]
    if (trVal === 0) { dxValues.push(0); continue }
    const diPlus = (smoothDMPs[i] / trVal) * 100
    const diMinus = (smoothDMMs[i] / trVal) * 100
    const sum = diPlus + diMinus
    if (sum === 0) { dxValues.push(0); continue }
    dxValues.push((Math.abs(diPlus - diMinus) / sum) * 100)
  }
  
  // Step 4: ADX = SMA of last 'period' DX values (matches Pine Script)
  if (dxValues.length === 0) return 0
  // Wilder's final ADX smoothing
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period
  }
  console.log(`[ADX] candles=${candles.length} dxVals=${dxValues.length} last3DX=${dxValues.slice(-3).map(v=>v.toFixed(1)).join(",")} ADX=${adxVal.toFixed(1)}`); return adxVal
}

export function momentumScore(candles: Candle[], period: number = 10): number[] {
  const result: number[] = []
  const closes = candles.map(c => c.close)
  for (let i = period; i < closes.length; i++) {
    result.push(closes[i] - closes[i - period])
  }
  return result
}

export interface IndicatorSnapshot {
  timestamp: number
  price: number
  ema9: number
  ema21: number
  rsi: number
  macd: { line: number; signal: number; histogram: number }
  atr: number
  roc: number
  adx: number
  features: Features
}

export function computeSnapshot(candles: Candle[]): IndicatorSnapshot {
  const lastCandle = candles[candles.length - 1]
  const ema9 = ema(candles, 9)
  const ema21 = ema(candles, 21)
  const rsiVal = rsi(candles, 14)
  const macdVal = macd(candles)
  const atrVal = atr(candles, 14)
  const rocVal = roc(candles, 12)
  const adxVal = adx(candles, 14)

  const spread = ema21 !== 0 ? ((ema9 - ema21) / ema21) * 100 : 0
  const prevEma9 = ema(candles.slice(0, -1), 9)
  const prevEma21 = ema(candles.slice(0, -1), 21)
  const wasBelowCross = prevEma9 < prevEma21 && ema9 > ema21 ? 1 : prevEma9 > prevEma21 && ema9 < ema21 ? -1 : 0

  const features: Features = {
    emaSpread: Math.tanh(spread / 100),
    crossover: wasBelowCross,
    rsi: (rsiVal - 50) / 50,
    macdHist: macdVal.histogram / (Math.abs(macdVal.histogram) + 0.001),
    atrPct: Math.tanh((atrVal / lastCandle.close) / 5),
    roc: Math.tanh(rocVal / 10),
    adx: (adxVal - 25) / 50,
    volSurge: 0,
    sideLong: ema9 > ema21 ? 1 : -1,
  }

  return {
    timestamp: Date.now(),
    price: lastCandle.close,
    ema9,
    ema21,
    rsi: rsiVal,
    macd: macdVal,
    atr: atrVal,
    roc: rocVal,
    adx: adxVal,
    features,
  }
}

export async function getFeatures(symbol: string, timeframe: string): Promise<Features> {
  try {
    const candles = await getCandles(symbol, timeframe, 100)
    if (!candles || candles.length < 50) {
      return {
        emaSpread: 0, crossover: 0, rsi: 0, macdHist: 0,
        atrPct: 0, roc: 0, adx: 0, volSurge: 0, sideLong: 0,
      }
    }

    const ema9 = ema(candles, 9)
    const ema21 = ema(candles, 21)
    const spread = ema21 !== 0 ? ((ema9 - ema21) / ema21) * 100 : 0

    const prevEma9 = ema(candles.slice(0, -1), 9)
    const prevEma21 = ema(candles.slice(0, -1), 21)
    const wasBelowCross = prevEma9 < prevEma21 && ema9 > ema21 ? 1 : prevEma9 > prevEma21 && ema9 < ema21 ? -1 : 0

    const rsiVal = rsi(candles, 14)
    const rsiNorm = (rsiVal - 50) / 50

    const { histogram } = macd(candles)
    const macdNorm = histogram / (Math.abs(histogram) + 0.001)

    const atrVal = atr(candles, 14)
    const close = candles[candles.length - 1].close
    const atrPct = close !== 0 ? (atrVal / close) * 100 : 0

    const rocVal = roc(candles, 12)
    const rocNorm = Math.tanh(rocVal / 10)

    const adxVal = adx(candles, 14)
    const adxNorm = (adxVal - 25) / 50

    const volNow = candles[candles.length - 1].quoteAssetVolume || 0
    const volAvg = candles.slice(-10).reduce((a, c) => a + (c.quoteAssetVolume || 0), 0) / 10
    const volSurgeVal = volAvg > 0 ? Math.log(volNow / volAvg + 1) : 0

    const sideLong = ema9 > ema21 ? 1 : -1

    return {
      emaSpread: Math.tanh(spread / 100),
      crossover: wasBelowCross,
      rsi: rsiNorm,
      macdHist: macdNorm,
      atrPct: Math.tanh(atrPct / 5),
      roc: rocNorm,
      adx: adxNorm,
      volSurge: Math.tanh(volSurgeVal),
      sideLong,
    }
  } catch (err) {
    console.error(`getFeatures(${symbol}) failed:`, err)
    return {
      emaSpread: 0, crossover: 0, rsi: 0, macdHist: 0,
      atrPct: 0, roc: 0, adx: 0, volSurge: 0, sideLong: 0,
    }
  }
}

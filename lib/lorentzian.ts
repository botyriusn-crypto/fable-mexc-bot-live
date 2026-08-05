// Lorentzian classification port based on jdehorty's MPL-2.0 TradingView indicator.
// Original: "Machine Learning: Lorentzian Classification". This implementation
// retains the closed-bar, four-bar-label, chronologically spaced ANN concepts.

import { adx, atr, ema, rsi } from "./indicators"
import type { Candle } from "./mexc/public"

export type LorentzianDirection = "long" | "short" | "neutral"

export interface LorentzianOptions {
  neighbors: number
  lookback: number
  confidenceThreshold: number
  useVolatilityFilter: boolean
  useRegimeFilter: boolean
  useAdxFilter: boolean
  regimeThreshold: number
  adxThreshold: number
  useKernelFilter: boolean
}

export interface LorentzianResult {
  direction: LorentzianDirection
  vote: number
  confidence: number
  neighborCount: number
  allowed: boolean
  ready: boolean
  reason: string
  filters: {
    volatility: boolean
    regime: boolean
    adx: boolean
    kernel: boolean
  }
}

type FeatureRow = [number, number, number, number, number]

const neutralResult = (reason: string): LorentzianResult => ({
  direction: "neutral",
  vote: 0,
  confidence: 0,
  neighborCount: 0,
  allowed: false,
  ready: false,
  reason,
  filters: { volatility: false, regime: false, adx: false, kernel: false },
})

function normalize(values: number[], smooth = 1): number[] {
  // Strictly chronological EMA to prevent look-ahead bias during backtest iteration
  const smoothed = smooth > 1 ? ema(values, smooth) : values
  return smoothed.map((value) => Math.max(0, Math.min(1, value / 100)))
}

function cci(candles: Candle[], period: number): number[] {
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3)
  return typical.map((value, index) => {
    const window = typical.slice(Math.max(0, index - period + 1), index + 1)
    const mean = window.reduce((sum, item) => sum + item, 0) / window.length
    const deviation = window.reduce((sum, item) => sum + Math.abs(item - mean), 0) / window.length
    if (deviation === 0) return 0.5
    const raw = (value - mean) / (0.015 * deviation)
    return Math.max(0, Math.min(1, (raw + 200) / 400))
  })
}

function waveTrend(candles: Candle[], channel = 10, average = 11): number[] {
  const source = candles.map((c) => (c.high + c.low + c.close) / 3)
  const esa = ema(source, channel)
  const deviation = ema(source.map((value, index) => Math.abs(value - esa[index])), channel)
  const composite = source.map((value, index) => deviation[index] === 0 ? 0 : (value - esa[index]) / (0.015 * deviation[index]))
  const wt = ema(composite, average)
  return wt.map((value) => Math.max(0, Math.min(1, (value + 100) / 200)))
}

function featureRows(candles: Candle[]): FeatureRow[] {
  const closes = candles.map((c) => c.close)
  const f1 = normalize(rsi(closes, 14))
  const f2 = waveTrend(candles)
  const f3 = cci(candles, 20)
  const f4 = normalize(adx(candles, 20))
  const f5 = normalize(rsi(closes, 9))
  return candles.map((_, index) => [f1[index], f2[index], f3[index], f4[index], f5[index]])
}

export function lorentzianDistance(current: FeatureRow, historical: FeatureRow): number {
  return current.reduce((sum, value, index) => sum + Math.log1p(Math.abs(value - historical[index])), 0)
}

function rationalQuadratic(values: number[], lookback = 8, relativeWeight = 8): number[] {
  return values.map((_, index) => {
    let weighted = 0
    let weights = 0
    const start = Math.max(0, index - lookback * 3)
    for (let sample = start; sample <= index; sample++) {
      const distance = index - sample
      const weight = Math.pow(1 + (distance * distance) / (2 * relativeWeight * lookback * lookback), -relativeWeight)
      weighted += values[sample] * weight
      weights += weight
    }
    return weights === 0 ? values[index] : weighted / weights
  })
}

export function classifyLorentzian(candles: Candle[], options: LorentzianOptions): LorentzianResult {
  const sniperOptions = options
  if (candles.length < 80) return neutralResult(`Warming up: ${candles.length}/80 closed candles`)

  const rows = featureRows(candles)
  const closes = candles.map((c) => c.close)
  const currentIndex = candles.length - 1
  const current = rows[currentIndex]
  const first = Math.max(30, candles.length - Math.max(80, sniperOptions.lookback))
  const lastLabeled = currentIndex - 4 // Hard stop to prevent future data peeking
  const candidates: Array<{ distance: number; label: number; index: number }> = []

  // Four-bar labels deliberately stop four bars before the current closed candle.
  // Sampling every fourth bar enforces chronological diversity among neighbors.
  for (let index = first; index <= lastLabeled; index++) {
    if ((index - first) % 4 !== 0) continue
    const future = closes[index + 4]
    const label = future > closes[index] ? 1 : future < closes[index] ? -1 : 0
    candidates.push({ distance: lorentzianDistance(current, rows[index]), label, index })
  }

  const neighbors = candidates
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, Math.max(1, sniperOptions.neighbors))
  if (neighbors.length === 0) return neutralResult("No labeled neighbors available")

  const vote = neighbors.reduce((sum, neighbor) => sum + neighbor.label, 0)
  const confidence = Math.abs(vote) / neighbors.length
  const direction: LorentzianDirection = vote > 0 ? "long" : vote < 0 ? "short" : "neutral"

  const atrFast = atr(candles, 1)[currentIndex]
  const atrSlow = atr(candles, 10)[currentIndex]
  const volatility = !sniperOptions.useVolatilityFilter || atrFast > atrSlow
  const adxValue = adx(candles, 14)[currentIndex]
  const adxPass = !sniperOptions.useAdxFilter || adxValue >= sniperOptions.adxThreshold
  const longEma = ema(closes, 200)
  const slope = currentIndex < 4 || longEma[currentIndex - 4] === 0
    ? 0
    : ((longEma[currentIndex] - longEma[currentIndex - 4]) / longEma[currentIndex - 4]) * 100
  const regime = !sniperOptions.useRegimeFilter || Math.abs(slope) >= Math.abs(sniperOptions.regimeThreshold)
  const kernel = rationalQuadratic(closes)
  const kernelDirection: LorentzianDirection = kernel[currentIndex] > kernel[currentIndex - 1]
    ? "long"
    : kernel[currentIndex] < kernel[currentIndex - 1]
      ? "short"
      : "neutral"
  const kernelPass = !sniperOptions.useKernelFilter || direction === kernelDirection
  const filters = { volatility, regime, adx: adxPass, kernel: kernelPass }
  const filtersPass = Object.values(filters).every(Boolean)
  const allowed = direction !== "neutral" && confidence >= sniperOptions.confidenceThreshold && filtersPass

  let reason = `${direction} vote ${vote > 0 ? "+" : ""}${vote}/${neighbors.length} (${Math.round(confidence * 100)}%)`
  if (!filtersPass) reason += `; blocked by ${Object.entries(filters).filter(([, pass]) => !pass).map(([name]) => name).join(", ")}`
  else if (confidence < options.confidenceThreshold) reason += "; below confidence threshold"

  return { direction, vote, confidence, neighborCount: neighbors.length, allowed, ready: true, reason, filters }
}

export function combineConfirmation(
  mode: string,
  candidate: "long" | "short",
  logisticAllowed: boolean,
  lorentzian: LorentzianResult,
): { allowed: boolean; reason: string } {
  const agrees = lorentzian.allowed && lorentzian.direction === candidate
  if (mode === "lorentzian") return { allowed: agrees, reason: agrees ? "Lorentzian confirmed" : `Lorentzian rejected: ${lorentzian.reason}` }
  if (mode === "both") return {
    allowed: logisticAllowed && agrees,
    reason: logisticAllowed && agrees ? "Both classifiers confirmed" : `Combined gate rejected: logistic=${logisticAllowed}, lorentzian=${agrees}`,
  }
  // Observe preserves the established logistic execution path while recording Lorentzian output.
  return { allowed: logisticAllowed, reason: mode === "observe" ? "Observe mode: logistic controls execution" : "Logistic gate controls execution" }
}

// Advanced Signal Strategy — additive layer on top of lib/strategy.ts.
import type { Candle } from "./mexc/public"
import { ema, adx, vwap } from "./indicators"

export interface AdvancedConfig {
  enabled: boolean
  mtfEnabled: boolean
  htfTimeframe: string
  htfEmaFast: number
  htfEmaSlow: number
  mtfMinAlignment: number
  smartMoneyEnabled: boolean
  fundingLongThreshold: number
  fundingShortThreshold: number
  oiDeltaThresholdPct: number
  cvdZThreshold: number
  dynamicSizingEnabled: boolean
  baseRiskPct: number
  maxRiskPct: number
  confidenceFloor: number
  maxPositionPct: number
}

export const DEFAULT_ADVANCED_CONFIG: AdvancedConfig = {
  enabled: false,
  mtfEnabled: true,
  htfTimeframe: "Min60",
  htfEmaFast: 9,
  htfEmaSlow: 21,
  mtfMinAlignment: 0.66,
  smartMoneyEnabled: true,
  fundingLongThreshold: -0.0005,
  fundingShortThreshold: 0.0005,
  oiDeltaThresholdPct: 2,
  cvdZThreshold: 1.5,
  dynamicSizingEnabled: true,
  baseRiskPct: 0.01,
  maxRiskPct: 0.02,
  confidenceFloor: 0.5,
  maxPositionPct: 0.25,
}

export interface TimeframeVote {
  timeframe: string
  direction: "long" | "short" | "neutral"
  adx: number
  emaFast: number
  emaSlow: number
  priceVsVwap: number
}

export interface MultiTimeframeResult {
  alignment: number
  votes: TimeframeVote[]
  aligned: boolean
  reason: string
}

function timeframeDirection(candles: Candle[], emaFast: number, emaSlow: number): TimeframeVote {
  if (candles.length < emaSlow + 2) {
    return { timeframe: "?", direction: "neutral", adx: 0, emaFast: 0, emaSlow: 0, priceVsVwap: 0 }
  }
  const closes = candles.map((c) => c.close)
  const f = ema(closes, emaFast)
  const s = ema(closes, emaSlow)
  const i = closes.length - 1
  const adxArr = adx(candles, 14)
  const v = vwap(candles)
  const price = closes[i]
  const direction: "long" | "short" | "neutral" =
    f[i] > s[i] ? "long" : f[i] < s[i] ? "short" : "neutral"
  return {
    timeframe: "?",
    direction,
    adx: adxArr[i] ?? 0,
    emaFast: f[i],
    emaSlow: s[i],
    priceVsVwap: price > v ? 1 : price < v ? -1 : 0,
  }
}

export function multiTimeframeAlignment(
  candlesByTf: Record<string, Candle[]>,
  candidate: "long" | "short",
  cfg: AdvancedConfig,
): MultiTimeframeResult {
  const votes: TimeframeVote[] = []
  for (const [tf, candles] of Object.entries(candlesByTf)) {
    const vote = timeframeDirection(candles, cfg.htfEmaFast, cfg.htfEmaSlow)
    vote.timeframe = tf
    votes.push(vote)
  }
  if (votes.length === 0) {
    return { alignment: 0, votes, aligned: false, reason: "no timeframe data" }
  }
  const agreeing = votes.filter((v) => v.direction === candidate).length
  const alignment = agreeing / votes.length
  const aligned = alignment >= cfg.mtfMinAlignment
  const reason = aligned
    ? `${agreeing}/${votes.length} timeframes agree with ${candidate}`
    : `only ${agreeing}/${votes.length} timeframes agree with ${candidate} (need ${Math.ceil(cfg.mtfMinAlignment * votes.length)})`
  return { alignment, votes, aligned, reason }
}

export interface SmartMoneyInput {
  fundingRate?: number
  openInterest?: number
  prevOpenInterest?: number
  cvd?: number
  cvdMean?: number
  cvdStd?: number
  takerBuyVolume?: number
  takerSellVolume?: number
  priceChangePct?: number
}

export interface SmartMoneyResult {
  score: number
  fundingSignal: number
  oiSignal: number
  cvdSignal: number
  takerSignal: number
  confirmed: boolean
  reason: string
}

export function smartMoneyConfirmation(
  input: SmartMoneyInput,
  candidate: "long" | "short",
  cfg: AdvancedConfig,
): SmartMoneyResult {
  let fundingSignal = 0
  if (input.fundingRate != null) {
    if (input.fundingRate > cfg.fundingShortThreshold) fundingSignal = -1
    else if (input.fundingRate < cfg.fundingLongThreshold) fundingSignal = 1
  }

  let oiSignal = 0
  if (input.openInterest != null && input.prevOpenInterest != null && input.prevOpenInterest > 0) {
    const oiDeltaPct = ((input.openInterest - input.prevOpenInterest) / input.prevOpenInterest) * 100
    if (Math.abs(oiDeltaPct) >= cfg.oiDeltaThresholdPct) {
      const priceUp = (input.priceChangePct ?? 0) >= 0
      if (oiDeltaPct > 0) oiSignal = priceUp ? 1 : -1
      else oiSignal = -1
    }
  }

  let cvdSignal = 0
  if (input.cvd != null) {
    const std = input.cvdStd ?? 1
    const z = std > 0 ? (input.cvd - (input.cvdMean ?? 0)) / std : 0
    if (Math.abs(z) >= cfg.cvdZThreshold) cvdSignal = z > 0 ? 1 : -1
  }

  let takerSignal = 0
  if (input.takerBuyVolume != null && input.takerSellVolume != null) {
    const total = input.takerBuyVolume + input.takerSellVolume
    if (total > 0) {
      const ratio = input.takerBuyVolume / total
      if (ratio >= 0.6) takerSignal = 1
      else if (ratio <= 0.4) takerSignal = -1
    }
  }

  const score = fundingSignal * 0.25 + oiSignal * 0.3 + cvdSignal * 0.3 + takerSignal * 0.15
  const confirmed = candidate === "long" ? score > 0 : score < 0
  const reason = confirmed
    ? `smart money confirms ${candidate} (score ${score.toFixed(2)})`
    : `smart money does not confirm ${candidate} (score ${score.toFixed(2)})`

  return { score, fundingSignal, oiSignal, cvdSignal, takerSignal, confirmed, reason }
}

export function confidenceScaledSize(
  equity: number,
  atr: number,
  price: number,
  confidence: number,
  cfg: AdvancedConfig,
): { sizeUsdt: number; riskPct: number; scaled: boolean } {
  if (atr <= 0 || price <= 0 || equity <= 0) {
    return { sizeUsdt: 0, riskPct: 0, scaled: false }
  }
  const confAboveFloor = Math.max(0, confidence - cfg.confidenceFloor)
  const confRange = Math.max(0.0001, 1 - cfg.confidenceFloor)
  const confFactor = Math.min(1, confAboveFloor / confRange)
  const riskPct = cfg.baseRiskPct + (cfg.maxRiskPct - cfg.baseRiskPct) * confFactor
  const stopDistance = atr * 1.5
  const riskAmount = equity * riskPct
  let sizeUsdt = riskAmount / (stopDistance / price)
  const maxSize = equity * cfg.maxPositionPct
  sizeUsdt = Math.min(sizeUsdt, maxSize)
  return { sizeUsdt, riskPct, scaled: true }
}

export interface AdvancedSignal {
  direction: "long" | "short" | null
  confidence: number
  mtf: MultiTimeframeResult | null
  smartMoney: SmartMoneyResult | null
  sizeUsdt: number | null
  passed: boolean
  reason: string
}

export function evaluateAdvancedEntry(
  baseDirection: "long" | "short",
  baseConfidence: number,
  candlesByTf: Record<string, Candle[]>,
  smartMoneyInput: SmartMoneyInput,
  equity: number,
  atr: number,
  price: number,
  cfg: AdvancedConfig,
): AdvancedSignal {
  if (!cfg.enabled) {
    return {
      direction: baseDirection,
      confidence: baseConfidence,
      mtf: null,
      smartMoney: null,
      sizeUsdt: null,
      passed: true,
      reason: "advanced strategy disabled — passing through base signal",
    }
  }

  const failures: string[] = []

  let mtf: MultiTimeframeResult | null = null
  if (cfg.mtfEnabled) {
    mtf = multiTimeframeAlignment(candlesByTf, baseDirection, cfg)
    if (!mtf.aligned) failures.push(mtf.reason)
  }

  let sm: SmartMoneyResult | null = null
  if (cfg.smartMoneyEnabled) {
    sm = smartMoneyConfirmation(smartMoneyInput, baseDirection, cfg)
    if (!sm.confirmed) failures.push(sm.reason)
  }

  let confidence = baseConfidence
  if (sm) confidence = Math.min(0.95, Math.max(0, confidence + sm.score * 0.1))

  const passed = failures.length === 0

  let sizeUsdt: number | null = null
  if (passed && cfg.dynamicSizingEnabled) {
    sizeUsdt = confidenceScaledSize(equity, atr, price, confidence, cfg).sizeUsdt
  }

  const reason = passed
    ? `${baseDirection.toUpperCase()} advanced entry passed (conf ${(confidence * 100).toFixed(1)}%)`
    : `${baseDirection.toUpperCase()} advanced entry blocked: ${failures.join("; ")}`

  return {
    direction: passed ? baseDirection : null,
    confidence,
    mtf,
    smartMoney: sm,
    sizeUsdt,
    passed,
    reason,
  }
}

// Rolling CVD buffer for z-score computation. In-memory and best-effort: it
// resets on cold start, so the z-score is only meaningful after a few ticks.
const cvdHistory: number[] = []
const CVD_HISTORY_MAX = 50

export function cvdRollingStats(cvd: number): { cvd: number; cvdMean: number; cvdStd: number } {
  cvdHistory.push(cvd)
  if (cvdHistory.length > CVD_HISTORY_MAX) cvdHistory.shift()
  const n = cvdHistory.length
  const mean = cvdHistory.reduce((a, b) => a + b, 0) / n
  const variance = cvdHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { cvd, cvdMean: mean, cvdStd: Math.sqrt(variance) }
}

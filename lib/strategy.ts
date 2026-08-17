// Signal evaluation: indicator triggers gated by ML confidence.
import { ema, vwap, marketStructure, volumeConfirmation } from "./indicators"
import type { IndicatorSnapshot, FeatureVector } from "./indicators"
import type { Candle } from "./mexc/public"
import type { BotConfig } from "./db/schema"
import { gateEntry, type MlState } from "./ml"

export type Regime = "trend" | "range" | "neutral"
export type StrategyKind = "trend" | "range"

export interface Signal {
  direction: "long" | "short" | null
  candidateDirection: "long" | "short" | null
  baseTriggered: boolean
  mlAllowed: boolean
  confidence: number
  features: FeatureVector | null
  strategy: StrategyKind
  dynamicSize: number | null
  regime: Regime
  reason: string
}

// Regime detection: ADX above trend threshold → trending market (EMA crossover
// strategy); ADX below range threshold → ranging market (mean-reversion
// strategy); in between → neutral, stand aside.
export function detectRegime(snap: IndicatorSnapshot, cfg: BotConfig): Regime {
  if (snap.adx >= cfg.adxTrendThreshold) return "trend"
  if (snap.adx <= cfg.adxRangeThreshold) return "range"
  return "neutral"
}

function evaluateTrendEntry(
  snap: IndicatorSnapshot,
  candles: Candle[],
  cfg: BotConfig,
): { direction: "long" | "short" | null; triggered: boolean; blockedReason: string } {
  // 5m/15m Sniper Logic: Avoid simple crossover whipsaws. 
  // Require confluence: Trend alignment + Momentum + VWAP.
  const vwapValue = vwap(candles.slice(-50)) // Short-term VWAP for intraday
  const isBullishTrend = snap.emaFast > snap.emaSlow
  const isBearishTrend = snap.emaFast < snap.emaSlow

  // Long confluence: Uptrend, price above VWAP, positive MACD momentum, not overbought
  if (isBullishTrend && snap.price > vwapValue && snap.macdHist > 0 && snap.rsi < cfg.rsiOverbought && cfg.allowLong) {
    return { direction: "long", triggered: true, blockedReason: "" }
  }
  
  // Short confluence: Downtrend, price below VWAP, negative MACD momentum, not oversold
  if (isBearishTrend && snap.price < vwapValue && snap.macdHist < 0 && snap.rsi > cfg.rsiOversold && cfg.allowShort) {
    return { direction: "short", triggered: true, blockedReason: "" }
  }

  return {
    direction: null,
    triggered: false,
    blockedReason: "Sniper confluence not met (Trend+VWAP+MACD)",
  }
}

// Range strategy: buy the bottom of the range, sell the top.
// Entry requires price at/beyond a Bollinger Band AND RSI confirmation.
function evaluateRangeEntry(
  snap: IndicatorSnapshot,
  cfg: BotConfig,
): { direction: "long" | "short" | null; triggered: boolean; blockedReason: string } {
  const atLower = snap.price <= snap.bbLower
  const atUpper = snap.price >= snap.bbUpper

  if (atLower && snap.rsi <= cfg.rsiOversold && cfg.allowLong) {
    return { direction: "long", triggered: true, blockedReason: "" }
  }
  if (atUpper && snap.rsi >= cfg.rsiOverbought && cfg.allowShort) {
    return { direction: "short", triggered: true, blockedReason: "" }
  }
  return {
    direction: null,
    triggered: false,
    blockedReason:
      atLower || atUpper ? "Band touch blocked by RSI filter or side toggle" : "Price inside range",
  }
}


// Dynamic Position Sizing: Risk a fixed % of equity per trade, adjusted by ATR.
// Incorporates a conservative Kelly fraction based on rolling win rate.
export function calculateDynamicSize(
  equity: number,
  atr: number,
  price: number,
  riskPct: number = 0.01, // Risk 1% of equity per trade
  maxKelly: number = 0.25 // Cap position size at 25% of equity
): { sizeUsdt: number; riskAmount: number; dynamicRisk: boolean } {
  if (atr <= 0 || price <= 0 || equity <= 0) {
    return { sizeUsdt: 0, riskAmount: 0, dynamicRisk: false };
  }
  
  const stopDistance = atr * 1.5; // 1.5x ATR stop loss assumption
  const riskAmount = equity * riskPct;
  
  // Base size: (Risk Amount / Stop Distance %)
  let sizeUsdt = riskAmount / (stopDistance / price);
  
  // Apply conservative Kelly cap (assuming 50% win rate, 1.5R:R for baseline)
  // Kelly = W - (1-W)/R = 0.5 - (0.5/1.5) = 0.166 (16.6%)
  // We cap at maxKelly to prevent over-leverage in highly volatile conditions
  const maxSize = equity * maxKelly;
  sizeUsdt = Math.min(sizeUsdt, maxSize);
  
  return { sizeUsdt, riskAmount, dynamicRisk: true };
}

export function evaluateEntry(
  snap: IndicatorSnapshot,
  candles: Candle[],
  cfg: BotConfig,
  model: MlState,
  equity: number = 10000,
): Signal {
  const regime = detectRegime(snap, cfg)

  // Resolve which strategy applies given the configured mode + detected regime
  let strategy: StrategyKind | null = null
  if (cfg.strategyMode === "trend") strategy = "trend"
  else if (cfg.strategyMode === "range") strategy = "range"
  else if (regime === "trend") strategy = "trend"
  else if (regime === "range") strategy = "range"
  // auto + neutral regime → stand aside

  if (!strategy) {
    return {
      direction: null,
      candidateDirection: null,
      baseTriggered: false,
      mlAllowed: false,
      confidence: 0,
      features: null,
      strategy: "trend",
      regime,
      dynamicSize: null,
      reason: `Neutral regime (ADX ${(snap.adx).toFixed(1)}) — standing aside`,
    }
  }

  const base = strategy === "trend" ? evaluateTrendEntry(snap, candles, cfg) : evaluateRangeEntry(snap, cfg)

  if (!base.direction) {
    return {
      direction: null,
      candidateDirection: null,
      baseTriggered: false,
      mlAllowed: false,
      confidence: 0,
      features: null,
      strategy,
      regime,
      dynamicSize: null,
      reason: base.blockedReason,
    }
  }

  const { sizeUsdt: dynamicSize } = calculateDynamicSize(equity, snap.atr, snap.price)

  const features: FeatureVector = {
    ...snap.features,
    sideLong: base.direction === "long" ? 1 : -1,
  }

  const { allowed, confidence } = gateEntry(model, features, cfg.mlConfidenceThreshold)

  return {
    direction: allowed ? base.direction : null,
    candidateDirection: base.direction,
    baseTriggered: true,
    mlAllowed: allowed,
    confidence,
    features,
    strategy,
    regime,
    dynamicSize,
    reason: allowed
      ? `${base.direction.toUpperCase()} entry [${strategy}]: ML confidence ${(confidence * 100).toFixed(1)}%`
      : `${base.direction.toUpperCase()} [${strategy}] signal rejected by ML gate (confidence ${(confidence * 100).toFixed(1)}%)`,
  }
}

// Is there an opposite-direction crossover against an open position?
export function isOppositeSignal(snap: IndicatorSnapshot, side: "long" | "short"): boolean {
  const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
  const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow
  return side === "long" ? bearishCross : bullishCross
}

// Auto-regime flip detection using multi-signal scoring
export function detectFlip(snap: IndicatorSnapshot, candles: Candle[], cfg: { emaFast: number; emaSlow: number }): "long" | "short" | "neutral" {
  let bullishScore = 0
  let bearishScore = 0
  
  if (candles.length >= 5) {
    const recentCloses = candles.slice(-3).map((c) => c.close)
    const emaFastRecent = ema(recentCloses, cfg.emaFast)
    const emaSlowRecent = ema(recentCloses, cfg.emaSlow)
    if (emaFastRecent > emaSlowRecent) bullishScore += 2
    else bearishScore += 2
  }
  
  if (snap.rsi > 50) bullishScore += 1
  else bearishScore += 1
  
  const vwapValue = vwap(candles)
  if (snap.price > vwapValue) bullishScore += 1
  else if (snap.price < vwapValue) bearishScore += 1
  
  const structure = marketStructure(candles)
  if (structure.higherHighs && structure.higherLows) bullishScore += 3
  if (structure.lowerHighs && structure.lowerLows) bearishScore += 3
  
  const highVolume = volumeConfirmation(candles)
  if (highVolume) {
    if (bullishScore > bearishScore) bullishScore += 2
    else if (bearishScore > bullishScore) bearishScore += 2
  }
  
  // Absolute assessment: need clear signal to act, otherwise stay neutral
  const totalBullish = bullishScore
  const totalBearish = bearishScore
  
  if (totalBullish >= 4 && totalBullish > totalBearish) return "long"
  if (totalBearish >= 4 && totalBearish > totalBullish) return "short"
  return "neutral"
}

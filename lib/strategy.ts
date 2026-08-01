// Signal evaluation: indicator triggers gated by ML confidence.

import type { BotConfig } from "./db/schema"
import type { IndicatorSnapshot, FeatureVector } from "./indicators"
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
  cfg: BotConfig,
): { direction: "long" | "short" | null; triggered: boolean; blockedReason: string } {
  const bullishCross = snap.prevEmaFast <= snap.prevEmaSlow && snap.emaFast > snap.emaSlow
  const bearishCross = snap.prevEmaFast >= snap.prevEmaSlow && snap.emaFast < snap.emaSlow

  if (bullishCross && snap.rsi < cfg.rsiOverbought && cfg.allowLong) {
    return { direction: "long", triggered: true, blockedReason: "" }
  }
  if (bearishCross && snap.rsi > cfg.rsiOversold && cfg.allowShort) {
    return { direction: "short", triggered: true, blockedReason: "" }
  }
  return {
    direction: null,
    triggered: false,
    blockedReason:
      bullishCross || bearishCross ? "Crossover blocked by RSI filter or side toggle" : "No crossover",
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

export function evaluateEntry(
  snap: IndicatorSnapshot,
  cfg: BotConfig,
  model: MlState,
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
      reason: `Neutral regime (ADX ${(snap.adx).toFixed(1)}) — standing aside`,
    }
  }

  const base = strategy === "trend" ? evaluateTrendEntry(snap, cfg) : evaluateRangeEntry(snap, cfg)

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
      reason: base.blockedReason,
    }
  }

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

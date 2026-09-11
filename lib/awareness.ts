// lib/awareness.ts
// The "one aware organism": a single shared state object that every layer
// WRITES into, and a single decide() that READS it out. No organ makes its
// own decision anymore — strategy, ML, grid, and risk all become writers.
//
// This is the fix for "separate parts that are not aware of each other":
// today the grid pauses on its own coin-aware ADX bar, the Lorentzian gates
// on its own ADX, the regime flips on adxTrendThreshold, and the scalper runs
// its own band — four organs, four thresholds, zero shared awareness. Here
// there is ONE regime signal and ONE decision.

import type { IndicatorSnapshot } from "./indicators"
import type { BotConfig } from "./db/schema"
import { detectRegime, type Regime } from "./strategy"
import type { ScalpSignal } from "./trend-scalper"

export type TrendDirection = "long" | "short" | "none"

export interface AwarenessState {
  symbol: string
  timeframe: string

  // ── Regime (ONE threshold drives everything) ──
  regime: Regime
  trendThreshold: number
  rangeThreshold: number

  // ── Trend (direction + strength) ──
  trend: TrendDirection
  trendStrength: number   // 0..1
  atr: number             // current ATR (for the 1R trail buffer)

  // ── ML (fused, not stacked) ──
  mlConfidence: number
  logisticConfidence: number
  lorentzianConfidence: number | null
  mlAllowed: boolean      // the combined logistic+Lorentzian gate result

  // ── Scalp signal (the trend-follower's edge, written by the scalper) ──
  scalp: ScalpSignal | null

  // ── Grid inventory (from gridOrders) ──
  gridNetExposure: number
  gridAvgEntry: number | null
  gridUnrealizedPnl: number

  // ── Risk ──
  exposurePct: number
  marginRemaining: number
  killSwitch: boolean
}

export type Decision =
  | { action: "scalp-trend"; direction: "long" | "short"; confidence: number }
  | { action: "grid-mean-revert" }
  | { action: "trail-inventory"; direction: "long" | "short" }
  | { action: "stand-aside"; reason: string }

// The single decision point. Every layer writes into AwarenessState; only this
// function reads it out and picks ONE action. This is what makes the bot one
// organism instead of four organs.
export function decide(state: AwarenessState): Decision {
  // 1. Risk gate always wins.
  if (state.killSwitch || state.marginRemaining <= 0) {
    return { action: "stand-aside", reason: "risk gate" }
  }

  // 2. Trending regime → trail aligned profitable inventory instead of
  // opening a fresh leg; a trail only ever tightens, never widens.
  if (state.regime === "trend") {
    const trendDir: "long" | "short" | null =
      state.trend === "long" || state.trend === "short" ? state.trend : null
    const inventoryAligned =
      (trendDir === "long" && state.gridNetExposure > 0) ||
      (trendDir === "short" && state.gridNetExposure < 0)
    // Minimum profit buffer before trailing: 1R (one ATR move on the net
    // position). Prevents flipping into trail mode on a rounding-error profit.
    const netQty = state.gridAvgEntry ? Math.abs(state.gridNetExposure) / state.gridAvgEntry : 0
    const oneR = state.atr * netQty
    if (inventoryAligned && state.gridUnrealizedPnl > oneR && trendDir) {
      return { action: "trail-inventory", direction: trendDir }
    }
  }

  // 3. A triggered, ML-allowed scalp trades in ANY regime. The scalp signal
  // carries its own trend evidence (EMA/VWAP alignment + structure + its own
  // ADX band), while the coarse regime label uses a stricter ADX cutoff
  // (25 vs the scalper's 18) — gating scalps on the label discarded ~2/3 of
  // measured 15m triggers (Sep 2026 probe: 22 of 33 dead in range/neutral).
  if (state.scalp?.triggered && state.scalp.direction && state.mlAllowed) {
    return {
      action: "scalp-trend",
      direction: state.scalp.direction,
      confidence: state.scalp.confidence,
    }
  }

  // 4. Ranging regime without a scalp setup → grid mean-reversion.
  if (state.regime === "range") {
    return { action: "grid-mean-revert" }
  }

  // 5. Trend without a scalp setup, or neutral → stand aside.
  return {
    action: "stand-aside",
    reason: state.regime === "trend" ? "trend but no scalp setup" : "neutral regime",
  }
}

// Assemble the shared state from all writers. This is the "organism" builder:
// it pulls each layer's slice into one object so decide() can see the whole.
// The scalper and ML gate are computed by their owners (engine.ts) and passed
// in as writes — buildAwareness only assembles, it does not decide.
export function buildAwareness(
  symbol: string,
  timeframe: string,
  snap: IndicatorSnapshot,
  cfg: BotConfig,
  scalp: ScalpSignal | null,
  grid: { netExposure: number; avgEntry: number | null; unrealizedPnl: number },
  risk: { exposurePct: number; marginRemaining: number; killSwitch: boolean },
  ml: { logistic: number; lorentzian: number | null; allowed: boolean },
): AwarenessState {
  const regime = detectRegime(snap, cfg)
  const trend: TrendDirection =
    snap.emaFast > snap.emaSlow ? "long" : snap.emaFast < snap.emaSlow ? "short" : "none"

  // Trend strength 0..1: how far ADX is above the trend threshold, clamped.
  const adxHeadroom = Math.max(0, snap.adx - cfg.adxTrendThreshold)
  const trendStrength = Math.min(1, adxHeadroom / Math.max(1, cfg.adxTrendThreshold))

  return {
    symbol,
    timeframe,
    regime,
    trendThreshold: cfg.adxTrendThreshold,
    rangeThreshold: cfg.adxRangeThreshold,
    trend,
    trendStrength,
    atr: snap.atr,
    mlConfidence: ml.lorentzian != null ? (ml.logistic + ml.lorentzian) / 2 : ml.logistic,
    logisticConfidence: ml.logistic,
    lorentzianConfidence: ml.lorentzian,
    mlAllowed: ml.allowed,
    scalp,
    gridNetExposure: grid.netExposure,
    gridAvgEntry: grid.avgEntry,
    gridUnrealizedPnl: grid.unrealizedPnl,
    exposurePct: risk.exposurePct,
    marginRemaining: risk.marginRemaining,
    killSwitch: risk.killSwitch,
  }
}

// --- Last-tick awareness cache (written by engine, read by /api/bot/state) ---
// The engine computes buildAwareness() + decide() on every trend-scalper tick.
// We cache the result here so the UI renders the *actual* last decision the
// organism made, rather than a re-computation that could drift from the engine.
let _lastAwareness: { state: AwarenessState; decision: Decision; at: number } | null = null

export function setLastAwareness(state: AwarenessState, decision: Decision): void {
  _lastAwareness = { state, decision, at: Date.now() }
}

export function getLastAwareness(): { state: AwarenessState; decision: Decision; at: number } | null {
  return _lastAwareness
}

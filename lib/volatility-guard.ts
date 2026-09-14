// Volatility surge detector — protects grids during extreme price moves
// and capitalizes on them by dynamically widening spacing.

import type { IndicatorSnapshot } from "./indicators"

export interface VolatilityState {
  surge: boolean           // Currently in a volatility surge
  surgeMultiplier: number  // How much to widen spacing (1.0 = normal)
  atrPercentile: number    // Current ATR as percentile of historical
  reason: string           // Human-readable explanation
}

// Track historical ATR values to detect surges
const atrHistory: Map<string, number[]> = new Map()
const SURGE_THRESHOLD = 2.5  // ATR must be 2.5x the median to trigger surge
const SURGE_SPACING_MULT = 3.0  // Widen spacing by 3x during surges
const HISTORY_SIZE = 100

export function detectVolatilitySurge(
  symbol: string,
  snap: IndicatorSnapshot
): VolatilityState {
  const price = snap.price
  const atrPct = price > 0 ? (snap.atr / price) * 100 : 0

  // Maintain rolling history of ATR values
  if (!atrHistory.has(symbol)) {
    atrHistory.set(symbol, [])
  }
  const history = atrHistory.get(symbol)!
  history.push(atrPct)
  if (history.length > HISTORY_SIZE) history.shift()

  // Need enough history to detect surges
  if (history.length < 20) {
    return {
      surge: false,
      surgeMultiplier: 1.0,
      atrPercentile: 50,
      reason: `Warming up (${history.length}/20 samples)`
    }
  }

  // Calculate median ATR
  const sorted = [...history].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // Calculate what percentile the current ATR is at
  const rank = sorted.filter(v => v <= atrPct).length
  const percentile = (rank / sorted.length) * 100

  // Detect surge: current ATR > SURGE_THRESHOLD × median
  const surge = atrPct > median * SURGE_THRESHOLD

  if (surge) {
    return {
      surge: true,
      surgeMultiplier: SURGE_SPACING_MULT,
      atrPercentile: percentile,
      reason: `Volatility surge: ATR ${atrPct.toFixed(2)}% vs median ${median.toFixed(2)}% (${percentile.toFixed(0)}th percentile). Widening spacing ${SURGE_SPACING_MULT}x to capture extreme moves.`
    }
  }

  // Recovering from surge — gradually reduce multiplier
  const wasRecentlySurging = sorted.slice(-5).some(v => v > median * SURGE_THRESHOLD)
  if (wasRecentlySurging) {
    return {
      surge: false,
      surgeMultiplier: 1.5,  // Gradually returning to normal
      atrPercentile: percentile,
      reason: `Volatility receding: ATR ${atrPct.toFixed(2)}% (${percentile.toFixed(0)}th percentile). Tighter spacing resuming.`
    }
  }

  // NOTE: there used to be a "flash move" branch here that compared
  // consecutive entries of `history` as if they were PRICES:
  //   Math.abs(v - recentCandles[i]) / recentCandles[i] * 100
  // `history` holds atrPct values, so a routine 10% relative shift in ATR%
  // (normal volatility drift) tripped a ">10% candle" flash-move flag. The
  // genuine single-candle spike case is already covered by the ATR-vs-median
  // surge check above. Real candle-level spike detection needs the candle's
  // OHLC, which this function is not given.

  return {
    surge: false,
    surgeMultiplier: 1.0,
    atrPercentile: percentile,
    reason: `Normal volatility: ATR ${atrPct.toFixed(2)}% (${percentile.toFixed(0)}th percentile)`
  }
}

// Calculate adaptive spacing based on volatility state.
//
// NOTE: currently NOT called by lib/grid.ts — setupGrid computes baseSpacing
// from Bollinger width / fee floor / a 2% cap and ignores
// volatility.surgeMultiplier, so the whole adaptive-spacing feature is inert
// today (its only effect is the surge log line). Wire it into setupGrid, or
// delete it — don't leave it looking live.
export function adaptiveSpacing(
  baseSpacing: number,
  volatility: VolatilityState,
  minSpacing: number
): number {
  return Math.max(baseSpacing * volatility.surgeMultiplier, minSpacing)
}

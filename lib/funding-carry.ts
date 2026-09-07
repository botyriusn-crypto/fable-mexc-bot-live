// lib/funding-carry.ts — "Bybit Funding Trading" strategy.
//
// Momentum on extreme funding (default): when funding is extreme AND still
// crowding (at/above its trailing mean), ride WITH the crowded side — price
// continues with funding direction OOS (15/18 cells positive, 8h best).
// Legacy fade mode (followTrend=false): fade the rollover. Lost OOS 18/18.
//
// Pure signal module — no I/O, no DB, fully unit-testable. The engine feeds it
// the current funding rate + trailing mean and acts on the returned signal.

export interface FundingCarryConfig {
  enabled: boolean
  fundingThreshold: number      // |funding| must exceed this to fire (decimal, e.g. 0.0001 = 0.01%)
  momentumLookbackSec: number   // trailing window for the "rolling over" mean (e.g. 259200 = 3d)
  horizonSec: number            // max position age before force-close (e.g. 86400 = 24h)
  sizeUsdt: number              // notional position size in USDT
  leverage: number              // leverage (set via /position/set-leverage, not on the order)
  tpBps: number                 // take-profit in basis points
  slBps: number                 // stop-loss in basis points
  // true (default, validated): ride crowding with the funding direction.
  // false: fade the rollover. OOS 180d/24-symbol: fade loses in 18/18
  // cells, momentum wins in 15/18 (8h: +74/+172/+205bps, t 2.3-2.7).
  followTrend?: boolean
}

export const DEFAULT_FUNDING_CARRY_CONFIG: FundingCarryConfig = {
  enabled: false,
  fundingThreshold: 0.0001,
  momentumLookbackSec: 259200,
  horizonSec: 28800,
  sizeUsdt: 50,
  leverage: 3,
  tpBps: 100,
  slBps: 25,
}

export interface FundingCarrySignal {
  direction: "long" | "short"
  reason: string
}

// Pure signal function. Returns a trade signal, or null to sit flat.
// The kill-switch lives here: all three conditions must pass or we do nothing.
export function detectFundingCarry(
  currentFundingRate: number,
  trailingMeanFunding: number,
  cfg: FundingCarryConfig,
): FundingCarrySignal | null {
  if (!cfg.enabled) return null

  // 1. Funding must be extreme (beyond threshold in either direction).
  if (Math.abs(currentFundingRate) <= cfg.fundingThreshold) return null

  // 2-3. Momentum (default): crowding still building — ride WITH it.
  // Fade (legacy): rollover + fade the crowded side. Fade lost OOS 18/18.
  if (cfg.followTrend ?? true) {
    if (currentFundingRate > 0) {
      if (currentFundingRate < trailingMeanFunding) return null
      return {
        direction: "long",
        reason: `funding +${(currentFundingRate * 100).toFixed(4)}% crowding (mean +${(trailingMeanFunding * 100).toFixed(4)}%)`,
      }
    }
    if (currentFundingRate > trailingMeanFunding) return null
    return {
      direction: "short",
      reason: `funding ${(currentFundingRate * 100).toFixed(4)}% crowding (mean ${(trailingMeanFunding * 100).toFixed(4)}%)`,
    }
  }

  // 2. Funding must be rolling over (current below trailing mean = crowd unwinding).
  if (currentFundingRate >= trailingMeanFunding) return null

  // 3. Mean-reversion direction: fade the crowded side.
  const direction: "long" | "short" = currentFundingRate > 0 ? "short" : "long"

  return {
    direction,
    reason: `funding ${(currentFundingRate * 100).toFixed(4)}% rolling over (mean ${(trailingMeanFunding * 100).toFixed(4)}%)`,
  }
}

// Compute the trailing mean funding rate from a sorted (oldest->newest) list of
// historical funding rates. Returns null if there aren't enough samples.
export function trailingMeanFunding(rates: number[], minSamples = 3): number | null {
  if (rates.length < minSamples) return null
  const sum = rates.reduce((a, b) => a + b, 0)
  return sum / rates.length
}

// Compute TP/SL prices from an entry price and the config (bps).
export function computeFundingStops(
  entryPrice: number,
  direction: "long" | "short",
  cfg: FundingCarryConfig,
): { takeProfit: number; stopLoss: number } {
  const tpMove = entryPrice * (cfg.tpBps / 10000)
  const slMove = entryPrice * (cfg.slBps / 10000)
  if (direction === "long") {
    return { takeProfit: entryPrice + tpMove, stopLoss: entryPrice - slMove }
  }
  return { takeProfit: entryPrice - tpMove, stopLoss: entryPrice + slMove }
}

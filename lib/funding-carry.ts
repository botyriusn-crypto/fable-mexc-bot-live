// lib/funding-carry.ts — "Bybit Funding Trading" strategy.
//
// Mean-reversion on extreme funding: when funding is extreme AND rolling over
// (current rate below its trailing mean), the crowded side is unwinding, so we
// fade it. High funding = crowded long -> short; low funding = crowded short -> long.
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
}

export const DEFAULT_FUNDING_CARRY_CONFIG: FundingCarryConfig = {
  enabled: false,
  fundingThreshold: 0.0001,
  momentumLookbackSec: 259200,
  horizonSec: 86400,
  sizeUsdt: 50,
  leverage: 3,
  tpBps: 50,
  slBps: 30,
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

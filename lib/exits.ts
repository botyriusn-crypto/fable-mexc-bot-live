// Adaptive TP/SL exit management: ATR stops, momentum-triggered trailing, break-even.

import type { Position, BotConfig } from "./db/schema"
import type { IndicatorSnapshot } from "./indicators"
import { momentumScore } from "./indicators"

export interface ExitDecision {
  action: "hold" | "close"
  reason?: "tp" | "sl" | "trail" | "signal"
  // Updated position fields to persist when holding
  updates: {
    stopLoss?: number
    trailingStop?: number
    trailingActive?: boolean
    breakEvenMoved?: boolean
    highestPrice?: number
    lowestPrice?: number
  }
  momentum: number
}

// Safety margin against liquidation: isolated-margin futures liquidate at
// roughly entryPrice/leverage away from entry (ignoring maintenance margin,
// which only tightens this further). Without a cap, ATR-based stop sizing
// can place the stop-loss BEYOND where the exchange would already have
// force-liquidated the position at high leverage — meaning the bot's own
// safety net never fires; the exchange's liquidation does, at a worse price
// plus a liquidation penalty. Capping SL at a fraction of that distance
// guarantees the coded stop always triggers well before liquidation.
const LIQUIDATION_SAFETY_FACTOR = 0.75

// Sniper-specific exit tuning: the sniper trades high-ATR, low-price coins
// where the global trail (1.2× ATR) is far too loose relative to its 3×-stop
// TP, so winners give back most of their gain. Sniper positions use a tighter
// trail and a higher momentum bar so the "let winners run" override only
// engages on genuinely strong momentum and banks the fixed TP otherwise.
const SNIPER_MOMENTUM_THRESHOLD = 0.7
const SNIPER_TRAIL_ATR_MULT = 0.6

export function computeInitialStops(
  side: "long" | "short",
  entryPrice: number,
  atrValue: number,
  cfg: Pick<BotConfig, "slAtrMult" | "tpAtrMult" | "leverage">,
): { stopLoss: number; takeProfit: number } {
  const atrSlDist = atrValue * cfg.slAtrMult
  const tpDist = atrValue * cfg.tpAtrMult
  const liquidationDistApprox = entryPrice / cfg.leverage
  const maxSafeSlDist = liquidationDistApprox * LIQUIDATION_SAFETY_FACTOR
  const slDist = Math.min(atrSlDist, maxSafeSlDist)
  return side === "long"
    ? { stopLoss: entryPrice - slDist, takeProfit: entryPrice + tpDist }
    : { stopLoss: entryPrice + slDist, takeProfit: entryPrice - tpDist }
}

export function evaluateExit(
  position: Position,
  snap: IndicatorSnapshot,
  cfg: BotConfig,
  oppositeSignal: boolean,
): ExitDecision {
  const price = snap.price
  const side = position.side as "long" | "short"
  const dir: 1 | -1 = side === "long" ? 1 : -1
  const atrValue = position.atrAtEntry ?? snap.atr
  const momentum = momentumScore(snap, dir)

  // Sniper positions use a tighter trail + higher momentum bar (see constants above).
  const isSniper = position.strategy === "sniper"
  const momentumThreshold = isSniper ? (cfg.sniperMomentumThreshold ?? SNIPER_MOMENTUM_THRESHOLD) : cfg.momentumThreshold
  const trailAtrMult = isSniper ? (cfg.sniperTrailAtrMult ?? SNIPER_TRAIL_ATR_MULT) : cfg.trailAtrMult

  const updates: ExitDecision["updates"] = {}

  // Track extremes
  const highest = Math.max(position.highestPrice ?? position.entryPrice, price)
  const lowest = Math.min(position.lowestPrice ?? position.entryPrice, price)
  updates.highestPrice = highest
  updates.lowestPrice = lowest

  const profitDist = (price - position.entryPrice) * dir

  // 1. Hard stop-loss check (always active)
  let stopLoss = position.stopLoss
  if (stopLoss != null) {
    const hitSl = side === "long" ? price <= stopLoss : price >= stopLoss
    if (hitSl) return { action: "close", reason: "sl", updates, momentum }
  }

  // 2. Break-even move: profit > 1x ATR → SL to entry
  if (!position.breakEvenMoved && profitDist >= atrValue) {
    stopLoss = position.entryPrice
    updates.stopLoss = stopLoss
    updates.breakEvenMoved = true
  }

  // 3. Momentum / hype detection
  const hypeActive = momentum >= momentumThreshold

  // 4. Trailing stop management
  let trailingActive = position.trailingActive
  let trailingStop = position.trailingStop

  if (hypeActive && profitDist > 0) {
    // Activate/update trailing mode — ride the trend, suspend fixed TP
    trailingActive = true
    // Trail distance scales with ATR; tightens as momentum fades toward threshold
    const momentumFactor = Math.max(0.5, Math.min(momentum / momentumThreshold, 1.5))
    const trailDist = atrValue * trailAtrMult * momentumFactor
    const candidate = side === "long" ? highest - trailDist : lowest + trailDist
    // Ratchet: only ever moves in favor of the position
    if (trailingStop == null) {
      trailingStop = candidate
    } else {
      trailingStop = side === "long" ? Math.max(trailingStop, candidate) : Math.min(trailingStop, candidate)
    }
    updates.trailingActive = true
    updates.trailingStop = trailingStop
  } else if (trailingActive && trailingStop != null) {
    // Momentum faded — tighten the trail to lock in gains
    const tightDist = atrValue * trailAtrMult * 0.5
    const candidate = side === "long" ? highest - tightDist : lowest + tightDist
    trailingStop = side === "long" ? Math.max(trailingStop, candidate) : Math.min(trailingStop, candidate)
    updates.trailingStop = trailingStop
  }

  // 5. Trailing stop hit?
  if (trailingActive && trailingStop != null) {
    const hitTrail = side === "long" ? price <= trailingStop : price >= trailingStop
    if (hitTrail) return { action: "close", reason: "trail", updates, momentum }
  }

  // 6. Fixed TP — only when trailing is NOT active (hype suspends TP)
  if (!trailingActive && position.takeProfit != null) {
    const hitTp = side === "long" ? price >= position.takeProfit : price <= position.takeProfit
    if (hitTp) {
      if (hypeActive) {
        // Hype at TP moment: skip TP, let the trail take over next evaluation
        updates.trailingActive = true
        const trailDist = atrValue * trailAtrMult
        updates.trailingStop = side === "long" ? highest - trailDist : lowest + trailDist
      } else {
        return { action: "close", reason: "tp", updates, momentum }
      }
    }
  }

  // 7. Opposite indicator signal closes the position (unless riding strong momentum)
  if (oppositeSignal && !hypeActive) {
    return { action: "close", reason: "signal", updates, momentum }
  }

  return { action: "hold", updates, momentum }
}

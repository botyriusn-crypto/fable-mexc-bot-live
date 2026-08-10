import type { Candle } from "./mexc/public"
import type { IndicatorSnapshot } from "./indicators"
import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { and, eq, isNull } from "drizzle-orm"

export const SNIPER_LIVE = false // Stage 2: flip to true after observe baseline proves hit-rate

export interface SniperSignal {
  direction: "long" | "short" | null
  reason: string
  confidence: number
  stopLoss: number
  takeProfit: number
}

const SWEEP_LOOKBACK = 20
const VOLUME_SURGE_MULT = 2.0
const SIGMA_EXTREME = 5.0

function avg(nums: number[]): number { 
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0 
}

export function detectSniper(candles: Candle[], snap: IndicatorSnapshot, fundingRate = 0): SniperSignal {
  const none: SniperSignal = { direction: null, reason: "no dislocation", confidence: 0, stopLoss: 0, takeProfit: 0 }
  if (candles.length < 60) return none
  
  const last = candles[candles.length - 1]
  const prev = candles.slice(-SWEEP_LOOKBACK - 1, -1)
  const swingLow = Math.min(...prev.map(c => c.low))
  const swingHigh = Math.max(...prev.map(c => c.high))
  const avgVol = avg(prev.map(c => c.volume))
  const volSurge = avgVol > 0 ? last.volume / avgVol : 1

  const bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= VOLUME_SURGE_MULT
  const bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && volSurge >= VOLUME_SURGE_MULT

  const closes = candles.map(c => c.close)
  const window = closes.slice(-100)
  const mean = avg(window)
  const sd = Math.sqrt(avg(window.map(c => (c - mean) ** 2))) || 1
  const z = (last.close - mean) / sd
  const exhaustedDown = z < -SIGMA_EXTREME && last.close > last.open
  const exhaustedUp = z > SIGMA_EXTREME && last.close < last.open

  let direction: "long" | "short" | null = null
  let confidence = 0
  let reason = ""
  let extreme = 0

  if (bullishReclaim) { 
    direction = "long"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; 
    reason = `Liquidity sweep: pierced ${swingLow.toFixed(6)} then reclaimed w/ ${volSurge.toFixed(1)}x volume`; extreme = last.low 
  } else if (bearishReclaim) { 
    direction = "short"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; 
    reason = `Liquidity sweep: pierced ${swingHigh.toFixed(6)} then rejected w/ ${volSurge.toFixed(1)}x volume`; extreme = last.high 
  } else if (exhaustedDown) { 
    direction = "long"; confidence = 0.65; 
    reason = `Sigma exhaustion: z=${z.toFixed(1)} crash w/ bullish reversal candle`; extreme = last.low 
  } else if (exhaustedUp) { 
    direction = "short"; confidence = 0.65; 
    reason = `Sigma exhaustion: z=${z.toFixed(1)} blow-off w/ bearish reversal candle`; extreme = last.high 
  }
  
  if (!direction) return none

  if (direction === "short" && fundingRate > 0.0005) { confidence += 0.1; reason += " + crowded longs (funding)" }
  if (direction === "long" && fundingRate < -0.0005) { confidence += 0.1; reason += " + crowded shorts (funding)" }

  const entry = last.close
  const stopLoss = direction === "long" ? Math.min(extreme, last.low) * 0.998 : Math.max(extreme, last.high) * 1.002
  const risk = Math.abs(entry - stopLoss)
  if (risk <= 0) return none
  const takeProfit = direction === "long" ? entry + risk * 3 : entry - risk * 3
  
  return { direction, reason, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit }
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal) {
  if (!sig.direction) return
  try {
    await db.insert(classifierDecisions).values({
      symbol, timeframe, candleTime,
      candidateDirection: sig.direction,
      strategy: "sniper",
      regime: "neutral",
      entryPrice: entry,
      confirmationMode: "ml",
      logisticAllowed: true,
      logisticConfidence: sig.confidence,
      lorentzianDirection: sig.direction,
      lorentzianVote: 1,
      lorentzianConfidence: sig.confidence,
      lorentzianAllowed: true,
      finalAllowed: true,
      reason: sig.reason,
    }).onConflictDoNothing()
  } catch (err) {}
}

export async function resolveSniperDecisions(): Promise<number> {
  return 0
}

// Stub to satisfy engine.ts import from Qwen Coder update
export async function maybeScanExchange(...args: any[]): Promise<any> {
  return null;
}

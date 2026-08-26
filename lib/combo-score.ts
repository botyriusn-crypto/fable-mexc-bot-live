import type { Candle } from "./mexc/public"

export interface ComboDna {
  chop: number; revRate: number; rangePct: number; driftPct: number;
  atrPct: number; touches: number; score: number;
  rejected?: boolean; rejectionReason?: string;
}

// COMBO GRID DNA: volatility is only profitable when it mean-reverts, and
// only survivable when the coin's actual trend state isn't already moving.
// Two independent hard gates below: drift (has it ALREADY moved a lot) and
// ADX (is it CURRENTLY trending, even if it hasn't drifted far yet — this
// catches setups that are about to run away right after entry).
export function comboDna(candles: Candle[], spacingPct = 0.6, lastAdx?: number): ComboDna {
  const n = candles.length
  const mid = candles[n - 1].close
  const path = candles.reduce((a, k) => a + (k.high - k.low), 0)
  const net = Math.abs(candles[n - 1].close - candles[0].close)
  const chop = path / Math.max(net, mid * 0.002)

  let rev = 0
  for (let i = 1; i < n; i++) {
    const a = Math.sign(candles[i].close - candles[i].open)
    const b = Math.sign(candles[i - 1].close - candles[i - 1].open)
    if (a !== 0 && a !== b) rev++
  }
  const revRate = rev / (n - 1)

  const maxH = Math.max(...candles.map(k => k.high))
  const minL = Math.min(...candles.map(k => k.low))
  const rangePct = ((maxH - minL) / mid) * 100
  const driftPct = ((candles[n - 1].close - candles[0].close) / candles[0].close) * 100
  const atrPct = ((path / n) / mid) * 100
  const touches = candles.reduce((a, k) => a + Math.floor((k.high - k.low) / (mid * (spacingPct / 100))), 0)

  const absDrift = Math.abs(driftPct)

  // HARD GATE 1: already moved a lot over the lookback window (pump/dump).
  if (absDrift > 20) {
    return {
      chop, revRate, rangePct, driftPct, atrPct, touches, score: 0,
      rejected: true,
      rejectionReason: `Pump/dump detected: ${driftPct.toFixed(1)}% drift (max 20%)`,
    }
  }
  // 1.4 Tighter drift gate for small accounts: reject anything that has
  // already drifted more than 8% over the lookback (was 15%). A COMBO grid
  // entering after an 8%+ move is very likely to keep going and bleed the
  // account before it can mean-revert.
  // ONDO-DNA bypass (validated 2026-08-23): coins with perfect ATR 0.6-1.2%
  // and ADX < 25 can handle 8-15% drift because they're in ideal grid fuel.
  const isOndoDna = atrPct >= 0.6 && atrPct <= 1.2 && (lastAdx ?? 99) < 25
  const driftThreshold = isOndoDna ? 15 : 8
  if (absDrift > driftThreshold && !isOndoDna) {
    return {
      chop, revRate, rangePct, driftPct, atrPct, touches, score: 0,
      rejected: true,
      rejectionReason: `High drift: ${driftPct.toFixed(1)}% (max ${driftThreshold}%)`,
    }
  }

  // HARD GATE 2: currently trending (ADX), independent of historical drift.
  // A coin can look calm on 3 days of candles and still be actively
  // trending right now — this is exactly the setup that runs away right
  // after a grid enters, which drift alone can't catch.
  if (lastAdx != null && lastAdx >= 30) {
    return {
      chop, revRate, rangePct, driftPct, atrPct, touches, score: 0,
      rejected: true,
      rejectionReason: `Trending market: ADX ${lastAdx.toFixed(1)} (max 30 for grid entry)`,
    }
  }

  const activity = Math.min(touches / 100, 1) * 50 + Math.min(atrPct / 3, 1) * 10
  const driftPenalty = absDrift * 3
  const rangeBonus = (rangePct >= 3 && rangePct <= 15) ? 10 : 0
  const quality =
    Math.min(chop / 8, 1) * 20 +
    Math.min(revRate / 0.5, 1) * 10 +
    rangeBonus +
    Math.max(0, 10 - driftPenalty)

  let score = Math.round(activity + quality)

  // 1.4 Elevated-drift penalty: candidates in the 5–8% drift band pass the
  // hard gate but are borderline, so dock their score to push them below
  // cleaner, calmer candidates in the ranking.
  if (absDrift > 5 && absDrift <= 8) {
    score = Math.max(0, Math.round(score - (absDrift - 5) * 3))
  }

  return { chop, revRate, rangePct, driftPct, atrPct, touches, score }
}

function suggestLeverage(dna: ComboDna, volumeUsdt: number): number {
  if (dna.rejected) return 1

  // Liquidity ceiling: 24h volume as a market-cap proxy. Large caps can
  // absorb higher leverage without slippage; micro caps cannot.
  let lev: number
  if (volumeUsdt >= 50_000_000) lev = 10
  else if (volumeUsdt >= 10_000_000) lev = 5
  else if (volumeUsdt >= 2_000_000) lev = 3
  else lev = 1

  // Volatility cap: high ATR% → pull down regardless of size.
  const atrPct = dna.atrPct
  if (atrPct >= 4.0) lev = Math.min(lev, 1)
  else if (atrPct >= 2.5) lev = Math.min(lev, 3)
  else if (atrPct >= 1.5) lev = Math.min(lev, 5)

  // Drift cap: already moved a lot → pull down regardless of size.
  const absDrift = Math.abs(dna.driftPct)
  if (absDrift > 8) lev = Math.min(lev, 1)
  else if (absDrift > 5) lev = Math.min(lev, 3)

  return lev
}

export function comboParams(dna: ComboDna, price: number, volumeUsdt: number) {
  const suggestedLeverage = suggestLeverage(dna, volumeUsdt)
  return {
    suggestedLeverage,
    spacingPct: Math.min(Math.max(dna.atrPct / 2, 0.4), 1.2),
    levels: Math.min(20, Math.max(6, Math.round(dna.rangePct / Math.min(Math.max(dna.atrPct / 2, 0.4), 1.2)))),
    atrMult: 0.5,
  }
}

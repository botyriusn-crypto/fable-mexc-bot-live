import type { Candle } from "./mexc/public"

export interface ComboDna {
  chop: number; revRate: number; rangePct: number; driftPct: number;
  atrPct: number; touches: number; score: number;
  rejected?: boolean; rejectionReason?: string;
}

// COMBO GRID DNA: volatility is only profitable when it mean-reverts.
export function comboDna(candles: Candle[], spacingPct = 0.6): ComboDna {
  const n = candles.length
  const mid = candles[n - 1].close
  const path = candles.reduce((a, k) => a + (k.high - k.low), 0)
  const net = Math.abs(candles[n - 1].close - candles[0].close)
  const chop = path / Math.max(net, mid * 0.002)
  
  // Calculate reversal rate
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
  
  // HARD GATES: Reject toxic coins immediately
  const absDrift = Math.abs(driftPct)
  if (absDrift > 20) {
    return { 
      chop, revRate, rangePct, driftPct, atrPct, touches, score: 0,
      rejected: true, 
      rejectionReason: `Pump/dump detected: ${driftPct.toFixed(1)}% drift (max 20%)`
    }
  }
  
  if (absDrift > 15) {
    return { 
      chop, revRate, rangePct, driftPct, atrPct, touches, score: 0,
      rejected: true, 
      rejectionReason: `High drift: ${driftPct.toFixed(1)}% (max 15%)`
    }
  }
  
  // Calculate activity and quality scores
  const activity = Math.min(touches / 100, 1) * 50 + Math.min(atrPct / 3, 1) * 10
  
  // Stronger drift penalty: lose 3 points per 1% of drift (was 0.5)
  const driftPenalty = absDrift * 3
  
  // Range bonus: reward contained volatility (3-15%)
  const rangeBonus = (rangePct >= 3 && rangePct <= 15) ? 10 : 0
  
  const quality =
    Math.min(chop / 8, 1) * 20 +
    Math.min(revRate / 0.5, 1) * 10 +
    rangeBonus +
    Math.max(0, 10 - driftPenalty) // More generous base, stronger penalty
  
  const score = Math.round(activity + quality)
  
  return { chop, revRate, rangePct, driftPct, atrPct, touches, score }
}

// Suggested grid parameters derived from DNA
function suggestLeverage(dna: ComboDna): number {
  // Reject high-drift coins from getting leverage
  if (dna.rejected) return 1
  
  const absDrift = Math.abs(dna.driftPct)
  if (dna.score >= 90 && absDrift < 3) return 10
  if (dna.score >= 80 && absDrift < 5) return 7
  if (dna.score >= 70 && absDrift < 8) return 5
  if (dna.score >= 60 && absDrift < 12) return 3
  return 1
}

export function comboParams(dna: ComboDna, price: number) {
  const suggestedLeverage = suggestLeverage(dna)
  return {
    suggestedLeverage,
    spacingPct: Math.min(Math.max(dna.atrPct / 2, 0.4), 1.2),
    levels: Math.min(20, Math.max(6, Math.round(dna.rangePct / Math.min(Math.max(dna.atrPct / 2, 0.4), 1.2)))),
    atrMult: 0.5,
  }
}

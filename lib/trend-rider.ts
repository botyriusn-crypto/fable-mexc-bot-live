// lib/trend-rider.ts — sustained-trend riding strategy.
// Confirms genuine multi-signal trend structure (swing HH/HL or LH/LL + ADX +
// EMA alignment + optional HTF alignment), enters on pullback (not chasing),
// and exits purely on structure invalidation / trailing structure stop.
// No fixed take-profit by design — winners are meant to run for the life of
// the trend, which is the specific gap this strategy fills.

import { type Candle } from "./exchange"
import { ema, atr, adx } from "./indicators"

export interface TrendState {
  inTrend: boolean
  direction: "long" | "short" | null
  rawStructureDirection: "long" | "short" | null // structure reading regardless of ADX/EMA confirmation, used to detect genuine reversals
  strength: number // 0-1 confidence score
  structureStopPrice: number | null
  trendAge: number // consecutive candles the trend has persisted (EMA-side + ADX-floor) in the confirmed direction; 0 when not in trend
  reasons: string[]
}

export interface TrendRiderConfig {
  swingLookback: number
  structureWindow: number
  emaSlowPeriod: number
  adxPeriod: number
  adxMinFloor: number
  atrPeriod: number
  atrStopBuffer: number
  pullbackEmaPeriod: number
  minStrength: number
  invalidationGraceCandles: number // consecutive weak/no-structure candles tolerated before exiting a held position
  minTrendAge: number // minimum consecutive candles the trend must have persisted before an entry is allowed (avoids entering on the birth candle of a move)
  pullbackTouchAtr: number // how close (in ATR) price must have retraced to the fast EMA to qualify as a genuine pullback entry
  requireRejectionCandle: boolean // if true, also require a rejection candle reclaiming the EMA in the trend direction before entering
  chandelierAtrMult: number // ATR multiple below the peak-favorable price for the chandelier trailing stop
  breakevenAtr: number // once price advances this many ATR from entry, ratchet stop to at least breakeven so a winner cannot become a loser
  htfTrailUseSwing: boolean // Step 7 exit anchor: true = exit on a close beyond the prior signal-tf swing; false = exit on a close beyond the signal-tf slow EMA
  regimeAdxMin: number // daily-timeframe ADX floor: below this the symbol is ranging/choppy and TrendRider sits out entirely
  regimeEmaPeriod: number // daily EMA period used for direction alignment in the regime gate
}

export const DEFAULT_TREND_RIDER_CONFIG: TrendRiderConfig = {
  swingLookback: 5,
  structureWindow: 30,
  emaSlowPeriod: 50,
  adxPeriod: 14,
  adxMinFloor: 22,
  atrPeriod: 14,
  atrStopBuffer: 0.5,
  pullbackEmaPeriod: 21,
  minStrength: 0.75,
  invalidationGraceCandles: 3,
  minTrendAge: 3,
  pullbackTouchAtr: 0.3,
  requireRejectionCandle: true,
  chandelierAtrMult: 3.0,
  breakevenAtr: 1.0,
  htfTrailUseSwing: true,
  regimeAdxMin: 20,
  regimeEmaPeriod: 20,
}

export interface TrendRiderPosition {
  side: "long" | "short"
  entryPrice: number
  entryTime: number
  stopPrice: number
  atrAtEntry: number
  weakStreak: number // consecutive candles where trend confirmation has softened, used for hysteresis
  peakPrice: number // most favorable price seen since entry (highest high for longs, lowest low for shorts); drives the chandelier trailing stop
}

export interface TrendRiderSignal {
  action: "enter" | "exit" | "hold" | "none"
  side?: "long" | "short"
  price?: number
  reason: string
}

function findSwingPoints(candles: Candle[], lookback: number) {
  const highs: { idx: number; price: number }[] = []
  const lows: { idx: number; price: number }[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1)
    const c = candles[i]
    if (c.high === Math.max(...window.map((w) => w.high))) highs.push({ idx: i, price: c.high })
    if (c.low === Math.min(...window.map((w) => w.low))) lows.push({ idx: i, price: c.low })
  }
  return { highs, lows }
}

function classifyStructure(
  candles: Candle[],
  cfg: TrendRiderConfig
): { direction: "long" | "short" | null; lastSwingLow: number | null; lastSwingHigh: number | null } {
  const window = candles.slice(-cfg.structureWindow)
  const { highs, lows } = findSwingPoints(window, cfg.swingLookback)

  if (highs.length < 2 || lows.length < 2) {
    return { direction: null, lastSwingLow: null, lastSwingHigh: null }
  }

  const lastTwoHighs = highs.slice(-2)
  const lastTwoLows = lows.slice(-2)

  const higherHighs = lastTwoHighs[1].price > lastTwoHighs[0].price
  const higherLows = lastTwoLows[1].price > lastTwoLows[0].price
  const lowerHighs = lastTwoHighs[1].price < lastTwoHighs[0].price
  const lowerLows = lastTwoLows[1].price < lastTwoLows[0].price

  let direction: "long" | "short" | null = null
  if (higherHighs && higherLows) direction = "long"
  else if (lowerHighs && lowerLows) direction = "short"

  return {
    direction,
    lastSwingLow: lastTwoLows[lastTwoLows.length - 1].price,
    lastSwingHigh: lastTwoHighs[lastTwoHighs.length - 1].price,
  }
}

export function detectTrendState(
  candles: Candle[],
  htfCandles: Candle[] | null,
  cfg: TrendRiderConfig = DEFAULT_TREND_RIDER_CONFIG
): TrendState {
  const reasons: string[] = []

  if (candles.length < cfg.structureWindow + cfg.swingLookback * 2) {
    return { inTrend: false, direction: null, rawStructureDirection: null, strength: 0, structureStopPrice: null, trendAge: 0, reasons: ["insufficient_candles"] }
  }

  const closes = candles.map((c) => c.close)
  const emaSlow = ema(closes, cfg.emaSlowPeriod)
  const adxVals = adx(candles, cfg.adxPeriod)
  const lastClose = closes[closes.length - 1]
  const lastEmaSlow = emaSlow[emaSlow.length - 1]
  const lastAdx = adxVals[adxVals.length - 1]
  const prevAdx = adxVals[adxVals.length - 5] ?? lastAdx

  const { direction: structDir, lastSwingLow, lastSwingHigh } = classifyStructure(candles, cfg)

  if (!structDir) {
    reasons.push("no_clear_structure")
    return { inTrend: false, direction: null, rawStructureDirection: null, strength: 0, structureStopPrice: null, trendAge: 0, reasons }
  }

  const adxOk = lastAdx >= cfg.adxMinFloor
  const adxRising = lastAdx > prevAdx
  if (!adxOk) reasons.push(`adx_below_floor(${lastAdx.toFixed(1)}<${cfg.adxMinFloor})`)
  if (!adxRising) reasons.push("adx_not_rising")

  const priceAboveEma = lastClose > lastEmaSlow
  const priceBelowEma = lastClose < lastEmaSlow
  const emaAligned = (structDir === "long" && priceAboveEma) || (structDir === "short" && priceBelowEma)
  if (!emaAligned) reasons.push("price_ema_misaligned")

  let htfAligned = true
  if (htfCandles && htfCandles.length >= cfg.emaSlowPeriod) {
    const htfCloses = htfCandles.map((c) => c.close)
    const htfEma = ema(htfCloses, cfg.emaSlowPeriod)
    const htfLastClose = htfCloses[htfCloses.length - 1]
    const htfLastEma = htfEma[htfEma.length - 1]
    htfAligned =
      (structDir === "long" && htfLastClose > htfLastEma) || (structDir === "short" && htfLastClose < htfLastEma)
    if (!htfAligned) reasons.push("htf_misaligned")
  }

  const confirmed = adxOk && emaAligned && htfAligned
  const strength = [adxOk, adxRising, emaAligned, htfAligned].filter(Boolean).length / 4

  // Trend age: walk backward over the already-computed EMA/ADX arrays counting
  // consecutive recent candles that stayed on the correct EMA side for this
  // structure direction AND at/above the ADX floor. Cheap (no re-detection)
  // and gives a faithful "how many candles has this trend persisted" measure
  // so entries can require a minimum age instead of firing on the birth candle.
  let trendAge = 0
  for (let k = closes.length - 1; k >= 0; k--) {
    const emaK = emaSlow[k]
    const adxK = adxVals[k]
    if (emaK == null || Number.isNaN(emaK) || adxK == null || Number.isNaN(adxK)) break
    const sideOk =
      (structDir === "long" && closes[k] > emaK) ||
      (structDir === "short" && closes[k] < emaK)
    if (sideOk && adxK >= cfg.adxMinFloor) {
      trendAge++
    } else {
      break
    }
  }

  return {
    inTrend: confirmed,
    direction: confirmed ? structDir : null,
    rawStructureDirection: structDir,
    strength,
    structureStopPrice: confirmed
  ? cfg.htfTrailUseSwing
    ? structDir === "long" ? lastSwingLow : lastSwingHigh
    : lastEmaSlow
  : null,
    trendAge,
    reasons: confirmed ? ["confirmed"] : reasons,
  }
}

// Called on every new candle close. `position` is null if flat, otherwise the
// current open trend-rider trade. Mutates `position.stopPrice`/`weakStreak` in
// place when trailing/tracking weakness — caller is responsible for
// persisting the mutated object.
export function evaluateTrendRider(
  candles: Candle[],
  htfCandles: Candle[] | null,
  position: TrendRiderPosition | null,
  cfg: TrendRiderConfig = DEFAULT_TREND_RIDER_CONFIG,
  regimeCandles: Candle[] | null = null
): TrendRiderSignal {
  const state = detectTrendState(htfCandles && htfCandles.length ? htfCandles : candles, null, cfg)
  const closes = candles.map((c) => c.close)
  const lastClose = closes[closes.length - 1]
  const atrVals = atr(candles, cfg.atrPeriod)
  const lastAtr = atrVals[atrVals.length - 1]
  // HTF (signal-timeframe) ATR — the trail must breathe on the SAME timeframe
  // the trend lives on. Min15 ATR is far too tight: it turns the chandelier
  // into a scalp stop and the breakeven ratchet into an instant lock, which is
  // why winners never run (avg hold 3.8h, avg win ~11 USDT). Anchor the trail
  // to the 4H ATR so 2.5x chandelier actually means "2.5x a 4H candle range".
  const htfAtrVals = htfCandles && htfCandles.length ? atr(htfCandles, cfg.atrPeriod) : null
  const lastHtfAtr = htfAtrVals && htfAtrVals.length ? htfAtrVals[htfAtrVals.length - 1] : null
  const trailAtr = lastHtfAtr || lastAtr

  if (position) {
    // Hard stop check ALWAYS runs first, regardless of confirmation state or
    // weak-streak grace — a held position must never be left unprotected
    // while we wait out the invalidation grace window.
    const stopHit =
      (position.side === "long" && lastClose <= position.stopPrice) ||
      (position.side === "short" && lastClose >= position.stopPrice)
    if (stopHit) {
      return { action: "exit", side: position.side, price: lastClose, reason: "structure_stop_hit" }
    }

    // Hard exit only on a genuine opposite-direction structure flip — this is
    // a real reversal, not noise, so bail immediately regardless of grace.
    const genuineReversal = state.rawStructureDirection !== null && state.rawStructureDirection !== position.side
    if (genuineReversal) {
      position.weakStreak = 0
      return { action: "exit", side: position.side, price: lastClose, reason: "trend_reversed" }
    }

    // Soft weakness: not fully confirmed anymore (ADX/EMA/HTF misaligned, or
    // structure temporarily unclear) but not a flip either — tolerate a few
    // consecutive candles of this before giving up, since single-candle noise
    // in the sliding swing window shouldn't kill an otherwise intact trend.
    // The hard stop above still protects the trade every candle during this
    // grace window, so tolerating weakness here no longer means going unprotected.
    const stillConfirmed = state.inTrend && state.direction === position.side
    if (!stillConfirmed) {
      position.weakStreak += 1
      
      // Profit-gated exit: only market-exit on trend_invalidated if the trade
      // is underwater. Profitable trades get breakeven protection and let the
      // chandelier/structure trail decide their fate — this is what "ride the
      // trend to a perfect exit" requires. Losers still cut fast.
      const inProfit =
        position.side === "long" ? lastClose > position.entryPrice : lastClose < position.entryPrice
      
      if (position.weakStreak > cfg.invalidationGraceCandles) {
        if (inProfit) {
          // Profitable but thesis weakening: ratchet stop to breakeven and
          // let the trail take us out near the peak instead of market-exiting
          // here and surrendering open profit.
          const beImproved =
            position.side === "long"
              ? position.entryPrice > position.stopPrice
              : position.entryPrice < position.stopPrice
          if (beImproved) position.stopPrice = position.entryPrice
          return { action: "hold", side: position.side, reason: `weak_streak(${position.weakStreak}/${cfg.invalidationGraceCandles})+profit_let_run` }
        } else {
          // Underwater and thesis invalidated: cut the loser immediately.
          return { action: "exit", side: position.side, price: lastClose, reason: "trend_invalidated" }
        }
      }
      return { action: "hold", side: position.side, reason: `weak_streak(${position.weakStreak}/${cfg.invalidationGraceCandles})` }
    }
    position.weakStreak = 0

    // --- Chandelier trailing stop (profit-locking) ---
    // Update the peak-favorable price, then trail a stop chandelierAtrMult ATR
    // behind it. This lets a genuine trend run while exiting near the peak on a
    // reversal, instead of surrendering open profit back through the soft-weak
    // grace window (the failure mode behind the ~37% win rate / thin avg win).
    const hi = candles[candles.length - 1].high
    const lo = candles[candles.length - 1].low
    if (position.side === "long") {
      position.peakPrice = Math.max(position.peakPrice, hi)
    } else {
      position.peakPrice = Math.min(position.peakPrice, lo)
    }

    const chandelier =
      position.side === "long"
        ? position.peakPrice - trailAtr * cfg.chandelierAtrMult
        : position.peakPrice + trailAtr * cfg.chandelierAtrMult

    // Breakeven ratchet: once price has advanced breakevenAtr ATR in our favor,
    // the stop may never sit worse than entry.
    const advancedAtr =
      position.side === "long"
        ? (lastClose - position.entryPrice) / (trailAtr || 1)
        : (position.entryPrice - lastClose) / (trailAtr || 1)
    const beFloor = advancedAtr >= cfg.breakevenAtr ? position.entryPrice : null

    let candidate = chandelier
    if (beFloor != null) {
      candidate = position.side === "long" ? Math.max(candidate, beFloor) : Math.min(candidate, beFloor)
    }

    const chandImproved =
      (position.side === "long" && candidate > position.stopPrice) ||
      (position.side === "short" && candidate < position.stopPrice)
    if (chandImproved) {
      position.stopPrice = candidate
      return { action: "hold", side: position.side, reason: "chandelier_trailed" }
    }

    if (state.structureStopPrice != null) {
      const buffered =
        position.side === "long"
          ? state.structureStopPrice - lastAtr * cfg.atrStopBuffer
          : state.structureStopPrice + lastAtr * cfg.atrStopBuffer

      const improved =
        (position.side === "long" && buffered > position.stopPrice) ||
        (position.side === "short" && buffered < position.stopPrice)

      if (improved) {
        position.stopPrice = buffered
        return { action: "hold", side: position.side, reason: "stop_trailed_up" }
      }
    }

    return { action: "hold", side: position.side, reason: "in_trend" }
  }

  if (!state.inTrend || state.strength < cfg.minStrength || state.structureStopPrice == null) {
    return { action: "none", reason: state.reasons.join(",") || "not_confirmed" }
  }
  // Regime gate (daily timeframe): short-lived 4H swings inside a ranging
  // market are exactly the whipsaw losers we saw on WLD/XRP/SUI/HBAR. Only
  // trade when the DAILY chart says a genuine multi-day trend exists (ADX
  // above floor) AND we're on the right side of it (close vs daily EMA).
  // Ranging symbols then sit out (no bleed) and auto-join when the pump starts.
  if (regimeCandles && regimeCandles.length >= cfg.regimeEmaPeriod + cfg.adxPeriod) {
    const rCloses = regimeCandles.map((cc) => cc.close)
    const rAdx = adx(regimeCandles, cfg.adxPeriod)
    const rLastAdx = rAdx[rAdx.length - 1] ?? 0
    const rEma = ema(rCloses, cfg.regimeEmaPeriod)
    const rLastClose = rCloses[rCloses.length - 1]
    const rLastEma = rEma[rEma.length - 1]
    const rSide = state.direction!
    const rAligned =
      (rSide === "long" && rLastClose > rLastEma) ||
      (rSide === "short" && rLastClose < rLastEma)
    if (rLastAdx < cfg.regimeAdxMin || !rAligned) {
      return { action: "none", reason: `regime_gate(dADX=${rLastAdx.toFixed(1)}<${cfg.regimeAdxMin}||misaligned)` }
    }
  }

  // Gate 1 — trend age: never enter on the birth candle(s) of a move. Whipsaw
  // risk is highest right as a trend is first confirmed; require it to have
  // persisted for minTrendAge candles first.
  if (state.trendAge < cfg.minTrendAge) {
    return { action: "none", reason: `trend_too_young(${state.trendAge}<${cfg.minTrendAge})` }
  }

  const emaFastArr = ema(closes, cfg.pullbackEmaPeriod)
  const emaFast = emaFastArr[emaFastArr.length - 1]
  const side = state.direction!

  // Gate 2 — genuine pullback: price must have retraced back toward the fast
  // EMA (within pullbackTouchAtr) on the current or previous candle. This
  // replaces the old "within 1.5 ATR" chase filter, which still allowed
  // entering while extended. We look at the last two candles' extreme in the
  // pullback direction (low for longs, high for shorts).
  const atr0 = lastAtr || 1
  const prevLow = candles.length >= 2 ? candles[candles.length - 2].low : candles[candles.length - 1].low
  const prevHigh = candles.length >= 2 ? candles[candles.length - 2].high : candles[candles.length - 1].high
  const lastLow = candles[candles.length - 1].low
  const lastHigh = candles[candles.length - 1].high

  const pullbackExtreme =
    side === "long" ? Math.min(lastLow, prevLow) : Math.max(lastHigh, prevHigh)
  const touchDistAtr = Math.abs(pullbackExtreme - emaFast) / atr0
  const touchedEma = touchDistAtr <= cfg.pullbackTouchAtr

  if (!touchedEma) {
    return { action: "none", reason: `no_pullback_to_ema(${touchDistAtr.toFixed(2)}atr>${cfg.pullbackTouchAtr})` }
  }

  // Gate 3 — rejection candle (optional): the current candle must close back
  // in the trend direction relative to the EMA, i.e. buyers/sellers reclaimed
  // control after the dip/pop. Confirms the pullback is ending, not extending.
  if (cfg.requireRejectionCandle) {
    const lastOpen = candles[candles.length - 1].open
    const bullishReclaim = side === "long" && lastClose > emaFast && lastClose > lastOpen
    const bearishReclaim = side === "short" && lastClose < emaFast && lastClose < lastOpen
    if (!bullishReclaim && !bearishReclaim) {
      return { action: "none", reason: "no_rejection_candle" }
    }
  }

  return {
    action: "enter",
    side,
    price: lastClose,
    reason: `pullback_entry(age=${state.trendAge},strength=${state.strength.toFixed(2)})`,
  }
}

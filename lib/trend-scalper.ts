// Trend-scalping signal engine.
//
// The pre-existing trend entry (strategy.evaluateTrendEntry) fires the moment
// EMA/VWAP/MACD align — which means it buys STRENGTH that is often already
// extended, giving poor reward:risk on a scalp timeframe. This module adds the
// missing timing edge: it only takes a trade when price PULLS BACK into the
// trend and then RESUMES, so entries sit near value (fast EMA / VWAP) with a
// tight, well-defined stop and a multiple-R target.
//
// It produces a single confluence score in [0,1] (usable directly as an ML-style
// confidence and for risk-based sizing) plus concrete SL/TP/size suggestions.
// It NEVER places orders itself — the engine remains the only execution path,
// so the portfolio risk layer and ML/Lorentzian gates still apply.

import type { Candle } from "./mexc/public"
import type { IndicatorSnapshot } from "./indicators"
import type { BotConfig } from "./db/schema"
import { ema, rsi, macdHistogram, vwap, marketStructure } from "./indicators"
import { calculateDynamicSize } from "./strategy"

export interface ScalpSignal {
  direction: "long" | "short" | null
  triggered: boolean
  confidence: number // confluence score 0..1
  reason: string
  stopLoss: number | null
  takeProfit: number | null
  atr: number
  suggestedSizeUsdt: number | null
  rMultiple: number
  filters: {
    adxOk: boolean
    volatilityOk: boolean
    trendAligned: boolean
    pulledBack: boolean
    resuming: boolean
  }
}

function envNum(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) ? v : def
}

// Tunable thresholds (env-overridable) — defaults chosen for 5–15m scalps.
const SCALP = {
  adxMin: () => envNum("SCALP_ADX_MIN", 18), // below → chop, stand aside
  adxMax: () => envNum("SCALP_ADX_MAX", 50), // above → trend likely exhausted / news spike
  atrPctMin: () => envNum("SCALP_ATRPCT_MIN", 0.0015), // 0.15% — need enough range to scalp
  atrPctMax: () => envNum("SCALP_ATRPCT_MAX", 0.06), // 6% — beyond this is unsafe chaos
  pullbackLookback: () => Math.round(envNum("SCALP_PULLBACK_LOOKBACK", 6)),
  scoreThreshold: () => envNum("SCALP_SCORE_THRESHOLD", 0.6),
  riskPct: () => envNum("SCALP_RISK_PCT", 0.01), // risk 1% of equity per scalp
  rMultiple: () => envNum("SCALP_R_MULTIPLE", 1.8), // target reward:risk
}

function nullSignal(reason: string, atr: number, filters: ScalpSignal["filters"]): ScalpSignal {
  return {
    direction: null,
    triggered: false,
    confidence: 0,
    reason,
    stopLoss: null,
    takeProfit: null,
    atr,
    suggestedSizeUsdt: null,
    rMultiple: SCALP.rMultiple(),
    filters,
  }
}

/**
 * Evaluate a trend-scalp opportunity for the current market snapshot.
 * Returns a triggered signal only when trend + pullback + resumption + momentum
 * confluence clears the score threshold.
 */
export function evaluateScalpSignal(
  snap: IndicatorSnapshot,
  candles: Candle[],
  cfg: BotConfig,
  equity: number,
): ScalpSignal {
  const baseFilters = { adxOk: false, volatilityOk: false, trendAligned: false, pulledBack: false, resuming: false }
  const price = snap.price
  const atrVal = snap.atr

  if (candles.length < 40 || price <= 0 || atrVal <= 0) {
    return nullSignal("Insufficient data for scalp evaluation", atrVal, baseFilters)
  }

  // ── Hard filter 1: trend strength band ──
  const adxOk = snap.adx >= SCALP.adxMin() && snap.adx <= SCALP.adxMax()
  // ── Hard filter 2: volatility band ──
  const atrPct = atrVal / price
  const volatilityOk = atrPct >= SCALP.atrPctMin() && atrPct <= SCALP.atrPctMax()

  const filters = { ...baseFilters, adxOk, volatilityOk }
  if (!adxOk) return nullSignal(`ADX ${snap.adx.toFixed(1)} outside scalp band [${SCALP.adxMin()}, ${SCALP.adxMax()}]`, atrVal, filters)
  if (!volatilityOk) return nullSignal(`ATR ${(atrPct * 100).toFixed(2)}% outside volatility band`, atrVal, filters)

  // ── Trend direction (EMA + VWAP + structure) ──
  const vwapVal = vwap(candles.slice(-50))
  const bull = snap.emaFast > snap.emaSlow && price > vwapVal
  const bear = snap.emaFast < snap.emaSlow && price < vwapVal
  const structure = marketStructure(candles, 20)

  const closes = candles.map((c) => c.close)
  const fastEmaSeries = ema(closes, cfg.emaFast)
  const rsiSeries = rsi(closes, cfg.rsiPeriod)
  const macdSeries = macdHistogram(closes)

  const lookback = SCALP.pullbackLookback()
  const recent = candles.slice(-lookback)
  const recentRsi = rsiSeries.slice(-lookback)
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const fastEmaNow = fastEmaSeries[fastEmaSeries.length - 1] ?? snap.emaFast
  const macdNow = macdSeries[macdSeries.length - 1] ?? snap.macdHist
  const macdPrev = macdSeries[macdSeries.length - 2] ?? macdNow

  let direction: "long" | "short" | null = null
  let trendAligned = false
  let pulledBack = false
  let resuming = false

  if (bull && cfg.allowLong && (structure.higherHighs || structure.higherLows)) {
    trendAligned = true
    // Pullback: at some point in the lookback price dipped toward/below fast EMA
    // OR RSI dipped into the 35–50 "buy-the-dip" zone.
    pulledBack =
      recent.some((c) => c.low <= fastEmaNow * 1.001) ||
      recentRsi.some((r) => r <= 48)
    // Resumption: latest candle is a bullish momentum bar closing back up, with
    // MACD histogram turning up.
    resuming = last.close > last.open && last.close > prev.close && macdNow >= macdPrev && snap.rsi < cfg.rsiOverbought
    if (trendAligned && pulledBack && resuming) direction = "long"
  } else if (bear && cfg.allowShort && (structure.lowerHighs || structure.lowerLows)) {
    trendAligned = true
    pulledBack =
      recent.some((c) => c.high >= fastEmaNow * 0.999) ||
      recentRsi.some((r) => r >= 52)
    resuming = last.close < last.open && last.close < prev.close && macdNow <= macdPrev && snap.rsi > cfg.rsiOversold
    if (trendAligned && pulledBack && resuming) direction = "short"
  }

  filters.trendAligned = trendAligned
  filters.pulledBack = pulledBack
  filters.resuming = resuming

  if (!direction) {
    return nullSignal(
      `No scalp setup (trend=${trendAligned} pullback=${pulledBack} resuming=${resuming})`,
      atrVal,
      filters,
    )
  }

  // ── Confluence score [0,1] ──
  // NOTE: a pullback entry, by construction, has weak/negative multi-bar ROC
  // (price just dipped), so a ROC-heavy momentum score would penalise exactly
  // the setups we want. Instead we grade the *resumption* itself: how decisive
  // the trigger bar is relative to ATR, plus volume, RSI room, MACD turn,
  // structure, and trend strength within the ADX band.
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
  // Resumption bar strength: body size of the trigger candle vs ATR.
  const resumeStrength = clamp01(Math.abs(last.close - last.open) / (atrVal || 1))
  // Volume: graded surge (recent vs baseline) rather than a hard yes/no.
  const volSurge = snap.volSurge ?? 1
  const volComponent = clamp01((volSurge - 1) / 2)
  // RSI positioning: reward entries with room to run (not already extended)
  const rsiRoom = direction === "long"
    ? clamp01((cfg.rsiOverbought - snap.rsi) / (cfg.rsiOverbought - 50))
    : clamp01((snap.rsi - cfg.rsiOversold) / (50 - cfg.rsiOversold))
  // MACD slope strength (histogram turning in trade direction)
  const macdSlope = clamp01(Math.abs(macdNow - macdPrev) / (atrVal * 0.5 || 1))
  // Structure quality
  const structScore = direction === "long"
    ? (structure.higherHighs ? 0.5 : 0) + (structure.higherLows ? 0.5 : 0)
    : (structure.lowerHighs ? 0.5 : 0) + (structure.lowerLows ? 0.5 : 0)
  // Trend strength credit within the ADX band.
  const adxComponent = clamp01((snap.adx - SCALP.adxMin()) / Math.max(1, SCALP.adxMax() - SCALP.adxMin()))

  const confidence =
    resumeStrength * 0.22 +
    volComponent * 0.18 +
    rsiRoom * 0.2 +
    macdSlope * 0.15 +
    structScore * 0.15 +
    adxComponent * 0.1

  if (confidence < SCALP.scoreThreshold()) {
    return nullSignal(
      `Scalp confluence ${(confidence * 100).toFixed(0)}% < ${(SCALP.scoreThreshold() * 100).toFixed(0)}% threshold`,
      atrVal,
      filters,
    )
  }

  // ── Execution params ──
  // ATR stop, capped so it always fires before liquidation (mirrors exits.ts).
  const liqDist = price / Math.max(1, cfg.leverage)
  const slDist = Math.min(atrVal * cfg.slAtrMult, liqDist * 0.75)
  const rMult = SCALP.rMultiple()
  const tpDist = slDist * rMult
  const stopLoss = direction === "long" ? price - slDist : price + slDist
  const takeProfit = direction === "long" ? price + tpDist : price - tpDist

  // Risk-based size: risk SCALP_RISK_PCT of equity over the actual stop distance,
  // scaled by confidence so weaker (but valid) setups commit less.
  const { sizeUsdt } = calculateDynamicSize(equity, atrVal, price, SCALP.riskPct())
  const suggestedSizeUsdt = sizeUsdt > 0 ? Math.max(0, sizeUsdt * confidence) : null

  return {
    direction,
    triggered: true,
    confidence,
    reason: `${direction.toUpperCase()} scalp: trend+pullback+resume, confluence ${(confidence * 100).toFixed(0)}% (resume ${(resumeStrength * 100).toFixed(0)}%, RSI room ${(rsiRoom * 100).toFixed(0)}%)`,
    stopLoss,
    takeProfit,
    atr: atrVal,
    suggestedSizeUsdt,
    rMultiple: rMult,
    filters,
  }
}

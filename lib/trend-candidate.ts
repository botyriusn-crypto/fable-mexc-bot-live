// Trend/scalp candidate scorer — replaces manual MAINBAR hunting.
//
// What makes a coin a great trend-trade (scalp) candidate, and how each
// attribute is measured here:
//
//   1. Trend strength ......... ADX(14): >25 = genuinely trending, not chop.
//   2. Momentum ............... 10-candle rate-of-change + EMA12/26 alignment.
//   3. Volume surge ........... current volume vs 20-candle average (hype footprint).
//   4. Liquidity hunt ......... stop-run wick beyond a prior extreme that
//                               reclaims back inside (bear/bull trap = fuel).
//   5. Squeeze fuel ........... funding rate leaning against the move
//                               (neg. funding + rising = short squeeze).
//   6. Volatility room ........ ATR% in a scalpable band and expanding —
//                               room for profit without gap-through-stop chop.
//   7. Market structure ....... HH/HL (long) or LH/LL (short) swings.
//   8. Hype / news / flows .... OPTIONAL external edge (-1..1, + favors longs):
//                               your own research, or a future CryptoDataAPI feed
//                               (funding/OI/liquidations/whale/sentiment). Neutral when absent.
//
// Penalties: chasing an overextended move (far from EMA20 in ATR units),
// buying an already-exploded 24h move, illiquid coins (disqualified),
// sub-half-cent coins (disqualified — 1000PEPE-class microstructure gets
// stop-hunted both directions; measured -$52/2d Sep 2026).

import { adx, atr, ema, marketStructure, rateOfChange, volumeSurge } from "./indicators"
import type { Candle } from "./mexc/public"

export type TrendDirection = "long" | "short" | "none"

export interface TrendExternalSignals {
  /** Directional edge from your own research / news / hype / flows. -1..1, + favors longs. */
  edge?: number
  /** Free-text note recorded on the score (e.g. "ETF rumor", "whale inflows"). */
  note?: string
}

export interface TrendCandidateInput {
  symbol: string
  /** Recent candles on the trade timeframe (15m recommended), oldest first. >= 45 needed. */
  candles: Candle[]
  lastPrice: number
  /** 24h quote turnover (USDT). Coins below minTurnover24h are disqualified. */
  turnover24h?: number
  /** 24h move as a decimal, e.g. 0.08 = +8%. */
  riseFallRate24h?: number
  /** Perps funding rate as a decimal, e.g. -0.0008. */
  fundingRate?: number
  /** Force a side, or "auto" (default) to score both and take the best. */
  direction?: "long" | "short" | "auto"
  external?: TrendExternalSignals
  minTurnover24h?: number
  /** Override for DEFAULT_MIN_CANDIDATE_PRICE (USDT). */
  minPriceUsdt?: number
}

export interface TrendFactor {
  name: string
  /** 0..1 contribution for the chosen side (0.5 = neutral/no info). */
  value: number
  weight: number
  detail: string
}

export interface TrendScore {
  symbol: string
  direction: TrendDirection
  /** 0..100. */
  score: number
  grade: "A+" | "A" | "B" | "C" | "D"
  /** Tradable as a fresh trend scalp right now. */
  tradable: boolean
  factors: TrendFactor[]
  reasons: string[]
  disqualified?: string
}

export interface UniverseRow {
  symbol: string
  turnover24h: number
  riseFallRate24h: number
  fundingRate?: number
  /** Last price (USDT). Unknown (undefined) passes the pre-screen; the deep
   * score still requires a price and fails closed without one. */
  lastPrice?: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const DEFAULT_MIN_TURNOVER = 500_000
// Minimum last price for auto-select candidates. Evidence-backed line:
// 1000PEPE @ 0.0034 bled -$52 in 2d (stopped both directions), while the
// 0.006-class runner the suite treats as tradable stays eligible.
const DEFAULT_MIN_CANDIDATE_PRICE = 0.005

function adxFactor(adxNow: number): number {
  if (adxNow < 15) return 0
  if (adxNow < 25) return ((adxNow - 15) / 10) * 0.5
  if (adxNow < 40) return 0.5 + ((adxNow - 25) / 15) * 0.5
  return 1
}

/** Stop-run wick + reclaim over the last 3 candles. side=+1 hunts lows (bullish fuel). */
function huntFactor(candles: Candle[], side: 1 | -1): { value: number; detail: string } {
  const recent = candles.slice(-4)
  if (recent.length < 4) return { value: 0, detail: "not enough candles for hunt read" }
  let best = 0
  let bestDesc = "no stop-run wick found"
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i]
    const range = Math.max(c.high - c.low, 1e-12)
    const prior = recent.slice(Math.max(0, i - 3), i)
    if (side === 1) {
      const priorLow = Math.min(...prior.map((p) => p.low))
      const lowerWick = (Math.min(c.open, c.close) - c.low) / range
      if (c.low < priorLow && c.close > priorLow && c.close >= c.open && lowerWick > 0.3) {
        const v = clamp01(0.5 + lowerWick * 0.5)
        if (v > best) {
          best = v
          bestDesc = `wick ${(lowerWick * 100).toFixed(0)}% below prior low with green reclaim`
        }
      }
    } else {
      const priorHigh = Math.max(...prior.map((p) => p.high))
      const upperWick = (c.high - Math.max(c.open, c.close)) / range
      if (c.high > priorHigh && c.close < priorHigh && c.close <= c.open && upperWick > 0.3) {
        const v = clamp01(0.5 + upperWick * 0.5)
        if (v > best) {
          best = v
          bestDesc = `wick ${(upperWick * 100).toFixed(0)}% above prior high with red reclaim`
        }
      }
    }
  }
  return { value: best, detail: bestDesc }
}

/** Funding leaning against the move = squeeze fuel. Returns 0..1 (0.5 neutral). */
function squeezeFactor(fundingRate: number | undefined, side: 1 | -1): { value: number; detail: string } {
  if (fundingRate == null || !Number.isFinite(fundingRate)) {
    return { value: 0.5, detail: "no funding data" }
  }
  const pct = fundingRate * 100
  // side=+1 (long): negative funding = crowded shorts = fuel. Positive = crowded longs = headwind.
  const signed = side === 1 ? -fundingRate : fundingRate
  const v = (clamp01(signed / 0.001) - 0.5) * 2 // -1..1
  return {
    value: clamp01((v + 1) / 2),
    detail: `funding ${pct >= 0 ? "+" : ""}${pct.toFixed(4)}% (${v > 0.2 ? "squeeze fuel" : v < -0.2 ? "crowded — headwind" : "neutral"})`,
  }
}

function volatilityFactor(atrNow: number, atrAvg: number, close: number): { value: number; detail: string } {
  if (!(atrNow > 0) || !(close > 0)) return { value: 0, detail: "no ATR read" }
  const atrPct = (atrNow / close) * 100
  let v: number
  if (atrPct < 0.05) v = clamp01(atrPct / 0.05) * 0.4
  else if (atrPct <= 1.5) v = 1
  else if (atrPct <= 3) v = 1 - ((atrPct - 1.5) / 1.5) * 0.6
  else v = 0.2
  const expanding = atrAvg > 0 && atrNow > atrAvg * 1.2
  if (expanding) v = Math.min(1, v + 0.15)
  return { value: v, detail: `ATR ${atrPct.toFixed(2)}% of price${expanding ? ", expanding" : ""}` }
}

function scoreSide(
  input: TrendCandidateInput,
  side: 1 | -1,
  ctx: {
    adxNow: number
    roc: number
    surge: number
    emaFastAboveSlow: boolean
    struct: number
    structDetail: string
    hunt: { value: number; detail: string }
    squeeze: { value: number; detail: string }
    vol: { value: number; detail: string }
    closes: number[]
    atrNow: number
  },
): { score: number; factors: TrendFactor[]; reasons: string[] } {
  const dirName = side === 1 ? "long" : "short"
  const mom = side === 1 ? clamp01(ctx.roc / 5) : clamp01(-ctx.roc / 5)
  const trendAligned = side === 1 ? ctx.emaFastAboveSlow : !ctx.emaFastAboveSlow
  const momentum = clamp01(mom * 0.7 + (trendAligned ? 0.3 : 0))
  const volume = clamp01((ctx.surge - 1) / 2)
  const ext = input.external?.edge ?? 0
  const external = clamp01(((side === 1 ? ext : -ext) + 1) / 2)

  const factors: TrendFactor[] = [
    { name: "trend (ADX)", value: adxFactor(ctx.adxNow), weight: 0.25, detail: `ADX ${ctx.adxNow.toFixed(1)}` },
    { name: "momentum", value: momentum, weight: 0.2, detail: `10-candle ROC ${ctx.roc >= 0 ? "+" : ""}${ctx.roc.toFixed(2)}%, EMA12/26 ${trendAligned ? "aligned" : "against"} ${dirName}` },
    { name: "volume surge", value: volume, weight: 0.15, detail: `${ctx.surge.toFixed(1)}x 20-candle average` },
    { name: "structure", value: ctx.struct, weight: 0.1, detail: ctx.structDetail },
    { name: "liquidity hunt", value: ctx.hunt.value, weight: 0.1, detail: ctx.hunt.detail },
    { name: "squeeze fuel", value: ctx.squeeze.value, weight: 0.1, detail: ctx.squeeze.detail },
    { name: "volatility room", value: ctx.vol.value, weight: 0.05, detail: ctx.vol.detail },
    {
      name: "hype/news/flows",
      value: external,
      weight: 0.05,
      detail: input.external?.note ?? (input.external?.edge != null ? `manual edge ${ext >= 0 ? "+" : ""}${ext}` : "no external signal"),
    },
  ]

  let score = factors.reduce((s, f) => s + f.value * f.weight, 0) * 100
  const reasons = factors
    .filter(
      (f) =>
        (f.value >= 0.6 && f.weight >= 0.1) ||
        // A strongly negative high-weight factor is a caution, not silence —
        // e.g. crowded-long funding zeroing the squeeze factor on a long.
        (f.value <= 0.2 && f.weight >= 0.1) ||
        (f.name === "liquidity hunt" && f.value >= 0.5),
    )
    .map((f) => `${f.name}: ${f.detail}`)

  // A manual research note is always worth surfacing, even though its weight is small.
  if (input.external?.note) reasons.push(`hype/news/flows: ${input.external.note}`)
  // Chase penalty: extended far beyond EMA20 in the trade direction.
  const ema20 = ema(ctx.closes, 20)
  const e20 = ema20[ema20.length - 1] ?? ctx.closes[ctx.closes.length - 1]
  const extAtr = ctx.atrNow > 0 ? ((ctx.closes[ctx.closes.length - 1] - e20) * side) / ctx.atrNow : 0
  if (extAtr > 2) {
    const pen = Math.min(15, (extAtr - 2) * 5)
    score -= pen
    reasons.push(`chase risk: ${extAtr.toFixed(1)} ATR beyond EMA20 (−${pen.toFixed(0)})`)
  }
  // Already-exploded 24h move: late entry.
  const day = Math.abs(input.riseFallRate24h ?? 0) * 100
  if (day > 25) {
    score -= 10
    reasons.push(`24h move ±${day.toFixed(0)}% — possibly the top (−10)`)
  }

  return { score: Math.max(0, Math.round(score)), factors, reasons }
}

export function scoreTrendCandidate(input: TrendCandidateInput): TrendScore {
  const { symbol, candles } = input
  const fail = (reason: string): TrendScore => ({
    symbol, direction: "none", score: 0, grade: "D", tradable: false, factors: [], reasons: [], disqualified: reason,
  })
  if (!Array.isArray(candles) || candles.length < 45) return fail(`only ${candles?.length ?? 0} candles — need 45+`)
  if (!(input.lastPrice > 0)) return fail("no last price")
  const minPrice = input.minPriceUsdt ?? DEFAULT_MIN_CANDIDATE_PRICE
  if (input.lastPrice < minPrice) {
    return fail(`last price $${input.lastPrice} below $${minPrice} minimum — sub-cent coins get stop-hunted, excluded from auto-select`)
  }
  const minTurnover = input.minTurnover24h ?? DEFAULT_MIN_TURNOVER
  if (input.turnover24h != null && input.turnover24h < minTurnover) {
    return fail(`24h turnover $${Math.round(input.turnover24h).toLocaleString()} below $${minTurnover.toLocaleString()} minimum — too illiquid to scalp`)
  }

  const closes = candles.map((c) => c.close)
  const adxArr = adx(candles)
  const adxNow = adxArr[adxArr.length - 1] ?? 0
  const rocArr = rateOfChange(closes, 10)
  const roc = rocArr[rocArr.length - 1] ?? 0
  const surgeArr = volumeSurge(candles, 20)
  const surge = surgeArr[surgeArr.length - 1] ?? 1
  const ef = ema(closes, 12)
  const es = ema(closes, 26)
  const emaFastAboveSlow = (ef[ef.length - 1] ?? 0) >= (es[es.length - 1] ?? 0)
  const ms = marketStructure(candles, 20)
  const atrArr = atr(candles, 14)
  const atrNow = atrArr[atrArr.length - 1] ?? 0
  const atrPrev = atrArr.slice(-15, -1).filter((v) => v > 0)
  const atrAvg = atrPrev.length ? atrPrev.reduce((a, b) => a + b, 0) / atrPrev.length : 0

  const sides = input.direction && input.direction !== "auto" ? [input.direction === "long" ? 1 : -1] as const : [1, -1] as const
  let best: { side: 1 | -1; score: number; factors: TrendFactor[]; reasons: string[] } | null = null
  for (const side of sides) {
    const structUp = ms.higherHighs && ms.higherLows
    const structDown = ms.lowerHighs && ms.lowerLows
    const struct = side === 1
      ? structUp ? 1 : ms.higherHighs || ms.higherLows ? 0.5 : 0
      : structDown ? 1 : ms.lowerHighs || ms.lowerLows ? 0.5 : 0
    const structDetail = side === 1
      ? structUp ? "HH + HL" : ms.higherHighs || ms.higherLows ? "partial up structure" : "no up structure"
      : structDown ? "LH + LL" : ms.lowerHighs || ms.lowerLows ? "partial down structure" : "no down structure"
    const r = scoreSide(input, side, {
      adxNow, roc, surge, emaFastAboveSlow, struct, structDetail,
      hunt: huntFactor(candles, side),
      squeeze: squeezeFactor(input.fundingRate, side),
      vol: volatilityFactor(atrNow, atrAvg, closes[closes.length - 1]),
      closes, atrNow,
    })
    if (!best || r.score > best.score) best = { side, ...r }
  }
  const chosen = best!
  const direction: TrendDirection = chosen.side === 1 ? "long" : "short"
  const grade = chosen.score >= 80 ? "A+" : chosen.score >= 65 ? "A" : chosen.score >= 50 ? "B" : chosen.score >= 35 ? "C" : "D"
  return {
    symbol,
    direction,
    score: chosen.score,
    grade,
    tradable: chosen.score >= 50,
    factors: chosen.factors,
    reasons: [`side: ${direction} (ADX ${adxNow.toFixed(1)})`, ...chosen.reasons],
  }
}

/** Rank a batch of candidates best-first. */
export function rankTrendCandidates(inputs: TrendCandidateInput[]): TrendScore[] {
  return inputs.map(scoreTrendCandidate).sort((a, b) => b.score - a.score)
}

export interface FlatCheckState {
  openPositions?: unknown[]
  grid?: {
    orders?: Array<{ status?: string }>
    allOrders?: Array<{ status?: string }>
  } | null
}

/**
 * True when nothing is open anywhere: no open positions and no pending grid
 * orders. The auto-scan may only switch the MAINBAR market in this state —
 * never mid-trade.
 */
export function isFlatForAutoSwitch(state: FlatCheckState): boolean {
  if ((state.openPositions?.length ?? 0) > 0) return false
  const orders = state.grid?.allOrders ?? state.grid?.orders ?? []
  return !orders.some((o) => o?.status === "pending")
}

/**
 * Winner for auto-select: best-first list means index 0, but prefer the top
 * TRADABLE setup over a higher-scoring disqualified/D-grade one. Returns null
 * when there is nothing worth loading into the selector.
 */
export function pickWinner(ranked: TrendScore[]): TrendScore | null {
  if (!Array.isArray(ranked) || ranked.length === 0) return null
  return ranked.find((s) => !s.disqualified && s.tradable) ?? null
}

/**
 * Cheap whole-universe pre-screen from 24h bulk tickers — no klines needed.
 * Returns the topN symbols worth deep-scoring (and picking in the MAINBAR).
 * Big |24h move| × log turnover, with a bonus for funding extremes (squeeze setups).
 */
export function screenUniverse(rows: UniverseRow[], topN = 10, minTurnover24h = DEFAULT_MIN_TURNOVER, minPriceUsdt = DEFAULT_MIN_CANDIDATE_PRICE): string[] {
  return rows
    .filter((r) => (r.turnover24h ?? 0) >= minTurnover24h)
    // Pre-screen is fail-open on unknown price (deep score fails closed);
    // known-cheap coins never occupy a shortlist slot.
    .filter((r) => r.lastPrice == null || r.lastPrice >= minPriceUsdt)
    .map((r) => {
      const move = Math.abs(r.riseFallRate24h ?? 0) * 100
      const fuel = Math.min(3, Math.abs(r.fundingRate ?? 0) * 1000)
      return { symbol: r.symbol, proxy: move * Math.log10(Math.max(10, r.turnover24h)) + fuel }
    })
    .sort((a, b) => b.proxy - a.proxy)
    .slice(0, Math.max(1, topN))
    .map((r) => r.symbol)
}

import { describe, it, expect } from "vitest"
import type { Candle } from "./mexc/public"
import { computeSnapshot } from "./indicators"
import { notionalToMarginUsdt } from "./strategy"
import { evaluateScalpSignal, macdTurnedUp, gradeFlowAgreement, scalpMarketEligible, SCALP, selectScalpFeedMarkets, SCALP_FEED_EXCLUDE, scalpFeedChanged } from "./trend-scalper"

// Minimal config matching the fields the scalper + computeSnapshot read.
const cfg: any = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  atrPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  allowLong: true,
  allowShort: true,
  leverage: 10,
  slAtrMult: 1.5,
  positionSizeUsdt: 50,
}

// Shared deterministic builders (see lib/test-candles.ts).
import { uptrendPullbackResume, chop } from "./test-candles"

describe("evaluateScalpSignal", () => {
  it("fires a long on a clean uptrend pullback-resume setup", () => {
    const candles = uptrendPullbackResume()
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    // Diagnostic output surfaces the exact failing filter if this ever breaks.
    console.log("uptrend signal:", JSON.stringify({ reason: sig.reason, adx: snap.adx, atrPct: snap.atr / snap.price, roc: snap.roc, volSurge: snap.volSurge, rsi: snap.rsi, filters: sig.filters, confidence: sig.confidence }))
    expect(sig.triggered).toBe(true)
    expect(sig.direction).toBe("long")
    expect(sig.stopLoss).not.toBeNull()
    expect(sig.takeProfit).not.toBeNull()
    expect(sig.stopLoss!).toBeLessThan(snap.price)
    expect(sig.takeProfit!).toBeGreaterThan(snap.price)
    // R:R must respect configured multiple (within rounding)
    const risk = snap.price - sig.stopLoss!
    const reward = sig.takeProfit! - snap.price
    expect(reward / risk).toBeGreaterThan(1.5)
  })

  it("stays silent in tight chop (low ADX / low volatility)", () => {
    const candles = chop()
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    console.log("chop signal:", JSON.stringify({ reason: sig.reason, adx: snap.adx, atrPct: snap.atr / snap.price }))
    expect(sig.triggered).toBe(false)
    expect(sig.direction).toBeNull()
  })

  it("accepts a MACD turn on the previous bar, rejects older turns", () => {
    // Long side: turn on this bar, turn on previous bar, no recent turn.
    expect(macdTurnedUp([0, -2, -1], 1)).toBe(true)
    expect(macdTurnedUp([0, 1, 0.5], 1)).toBe(true)
    expect(macdTurnedUp([2, 1, 0], 1)).toBe(false)
    // Short side mirrors.
    expect(macdTurnedUp([0, 2, 1], -1)).toBe(true)
    expect(macdTurnedUp([0, -1, -0.5], -1)).toBe(true)
    expect(macdTurnedUp([-2, -1, 0], -1)).toBe(false)
    // Too short to judge.
    expect(macdTurnedUp([1, 2], 1)).toBe(false)
  })

  it("resumes on a directional bar even when it doesn't exceed the prior close", () => {
    // Lift the previous close a touch above the trigger bar's close: the
    // trigger bar itself is untouched (still green, MACD turning), so the
    // only thing the old vs-prev clause could object to is gone with it.
    const candles = uptrendPullbackResume()
    const lastClose = candles[candles.length - 1].close
    const prev = candles[candles.length - 2]
    const lifted = lastClose * 1.002
    candles[candles.length - 2] = {
      ...prev,
      high: Math.max(prev.high, lifted * 1.001),
      close: lifted,
    }
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 10000)
    expect(sig.filters.resuming).toBe(true)
    expect(sig.direction).toBe("long")
  })

  it("defaults the volatility ceiling to 10% (ATR risk is priced by sizing)", () => {
    delete process.env.SCALP_ATRPCT_MAX
    expect(SCALP.atrPctMax()).toBe(0.1)
    expect(SCALP.atrPctMin()).toBe(0.0015)
  })

  it("defaults the confluence threshold to 0.5 (measured 1-3% setup rate)", () => {
    delete process.env.SCALP_SCORE_THRESHOLD
    expect(SCALP.scoreThreshold()).toBe(0.5)
  })

  it("stays silent when there is insufficient data", () => {
    const candles = uptrendPullbackResume().slice(-10)
    const snap = computeSnapshot(candles, cfg)
    const sig = evaluateScalpSignal(snap, candles, cfg, 400)
    expect(sig.triggered).toBe(false)
  })

  it("converts risk notional to margin without leverage inflation", () => {
    expect(notionalToMarginUsdt(1000, 10)).toBe(100)
    expect(notionalToMarginUsdt(1000, 1)).toBe(1000)
    expect(notionalToMarginUsdt(0, 10)).toBe(0)
    expect(notionalToMarginUsdt(-50, 10)).toBe(0)
    expect(notionalToMarginUsdt(1000, 0)).toBe(1000)
  })

  it("risks at most 1% of equity at 10x after margin conversion", () => {
    const candles = uptrendPullbackResume()
    const snap = computeSnapshot(candles, cfg)
    const equity = 10000
    const sig = evaluateScalpSignal(snap, candles, cfg, equity)
    expect(sig.triggered).toBe(true)
    expect(sig.suggestedSizeUsdt).not.toBeNull()
    expect(sig.stopLoss).not.toBeNull()
    // What the engine actually risks now that the notional is booked as margin:
    const margin = notionalToMarginUsdt(sig.suggestedSizeUsdt!, cfg.leverage)
    const stopDist = snap.price - sig.stopLoss!
    const stopFrac = stopDist / snap.price
    const actualRisk = margin * cfg.leverage * stopFrac
    // Safety property: realized risk never exceeds the configured 1% × confidence.
    // (The Kelly cap can only push it lower.)
    expect(actualRisk).toBeLessThanOrEqual(equity * 0.01 * sig.confidence + 0.5)
    // Composition check: margin booking preserves the sizing math exactly.
    // (sizing assumes a 1.5×ATR stop; the capped notional × confidence × the
    // actual stop fraction is what the account really risks.)
    const uncapped = (equity * 0.01) / ((1.5 * sig.atr) / snap.price)
    const expected = Math.min(uncapped, equity * 0.25) * sig.confidence * stopFrac
    expect(actualRisk).toBeCloseTo(expected, 0)
    // Pre-fix behavior booked the raw notional as margin, so the engine
    // multiplied by leverage again — exactly leverage× the realized risk.
    const prefixRisk = sig.suggestedSizeUsdt! * cfg.leverage * stopFrac
    expect(prefixRisk / actualRisk).toBeCloseTo(cfg.leverage, 0)
  })
})

describe("taker-flow confirmation", () => {
  const agreeLong = { takerBuyVolume: 90, takerSellVolume: 10, cvd: 80 }
  const opposeLong = { takerBuyVolume: 10, takerSellVolume: 90, cvd: -80 }
  const empty = { takerBuyVolume: 0, takerSellVolume: 0, cvd: 0 }

  it("grades directional agreement on [0,1] with 0.5 neutral", () => {
    expect(gradeFlowAgreement("long", agreeLong)).toBeCloseTo(0.9, 6)
    expect(gradeFlowAgreement("long", opposeLong)).toBeCloseTo(0.1, 6)
    expect(gradeFlowAgreement("short", agreeLong)).toBeCloseTo(0.1, 6)
    expect(gradeFlowAgreement("short", opposeLong)).toBeCloseTo(0.9, 6)
    expect(gradeFlowAgreement("long", empty)).toBe(0.5)
  })

  it("weight 0 (default): passing flow changes nothing", () => {
    delete process.env.SCALP_FLOW_WEIGHT
    const candles = uptrendPullbackResume()
    const snap = computeSnapshot(candles, cfg)
    const plain = evaluateScalpSignal(snap, candles, cfg, 400)
    const withFlow = evaluateScalpSignal(snap, candles, cfg, 400, agreeLong)
    expect(withFlow.confidence).toBe(plain.confidence)
    expect(withFlow.triggered).toBe(plain.triggered)
  })

  it("weight > 0: agreeing flow raises, opposing flow lowers confidence", () => {
    process.env.SCALP_FLOW_WEIGHT = "0.3"
    try {
      const candles = uptrendPullbackResume()
      const snap = computeSnapshot(candles, cfg)
      const base = evaluateScalpSignal(snap, candles, cfg, 400)
      const agreed = evaluateScalpSignal(snap, candles, cfg, 400, agreeLong)
      const opposed = evaluateScalpSignal(snap, candles, cfg, 400, opposeLong)
      expect(base.triggered).toBe(true)
      expect(agreed.confidence).toBeGreaterThan(base.confidence)
      expect(opposed.confidence).toBeLessThan(base.confidence)
      // Missing flow with weight on falls back to the legacy score.
      const noFlow = evaluateScalpSignal(snap, candles, cfg, 400, undefined)
      expect(noFlow.confidence).toBe(base.confidence)
    } finally {
      delete process.env.SCALP_FLOW_WEIGHT
    }
  })
})

describe("scalpMarketEligible", () => {
  it("default (multi off): selected market only, never into an open position", () => {
    delete process.env.SCALP_MULTI_MARKET
    expect(scalpMarketEligible({ isSelected: true, hasOpenPosition: false, openScalpCount: 0 })).toBe(true)
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 0 })).toBe(false)
    expect(scalpMarketEligible({ isSelected: true, hasOpenPosition: true, openScalpCount: 0 })).toBe(false)
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: true, openScalpCount: 0 })).toBe(false)
  })

  it("multi on: any position-free market while under the cap", () => {
    const opts = { multiMarket: true, maxOpen: 2 }
    expect(scalpMarketEligible({ isSelected: true, hasOpenPosition: false, openScalpCount: 0 }, opts)).toBe(true)
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 0 }, opts)).toBe(true)
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 1 }, opts)).toBe(true)
    // Cap binds every market, selected included.
    expect(scalpMarketEligible({ isSelected: true, hasOpenPosition: false, openScalpCount: 2 }, opts)).toBe(false)
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 2 }, opts)).toBe(false)
    // Per-market one-position rule always holds.
    expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: true, openScalpCount: 0 }, opts)).toBe(false)
  })

  it("reads multi/cap from env when opts omitted", () => {
    process.env.SCALP_MULTI_MARKET = "1"
    process.env.SCALP_MAX_OPEN = "1"
    try {
      expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 0 })).toBe(true)
      expect(scalpMarketEligible({ isSelected: false, hasOpenPosition: false, openScalpCount: 1 })).toBe(false)
    } finally {
      delete process.env.SCALP_MULTI_MARKET
      delete process.env.SCALP_MAX_OPEN
    }
  })
})

const tick = (symbol: string, movePct: number, turnover: number, price = 10): any => ({
  symbol,
  lastPrice: price,
  fundingRate: 0.0001,
  volume24: 0,
  amount24: turnover,
  riseFallRate: movePct / 100,
})

const FEED_TICKERS = [
  tick("SOL_USDT", 12, 50_000_000),
  tick("HYPE_USDT", 3, 30_000_000),
  tick("FARTCOIN_USDT", 25, 80_000_000), // unvalidated: biggest mover, must not pass
  tick("ENA_USDT", 15, 60_000_000), // hard-excluded (grid-trial sanctity)
  tick("DOGE_USDT", -8, 40_000_000, 0.2),
]

describe("selectScalpFeedMarkets", () => {
  it("admits validated movers ranked by move size", () => {
    expect(selectScalpFeedMarkets(FEED_TICKERS)).toEqual(["SOL_USDT", "DOGE_USDT", "HYPE_USDT"])
  })

  it("bars unvalidated symbols no matter how hard they move", () => {
    expect(selectScalpFeedMarkets(FEED_TICKERS)).not.toContain("FARTCOIN_USDT")
  })

  it("bars ENA, already-ticked, and realized losers", () => {
    expect(SCALP_FEED_EXCLUDE.has("ENA_USDT")).toBe(true)
    const base = selectScalpFeedMarkets(FEED_TICKERS)
    expect(base).not.toContain("ENA_USDT")
    expect(selectScalpFeedMarkets(FEED_TICKERS, { exclude: new Set(["SOL_USDT"]) })[0]).toBe("DOGE_USDT")
    expect(
      selectScalpFeedMarkets(FEED_TICKERS, { realizedLosers: new Set(["SOL_USDT", "HYPE_USDT"]) }),
    ).toEqual(["DOGE_USDT"])
  })

  it("caps breadth and skips non-USDT symbols", () => {
    const tickers = [...FEED_TICKERS, { ...tick("XRP_USDT", 5, 20_000_000) }, { symbol: "BTC-PERP", lastPrice: 1, fundingRate: 0, volume24: 1, riseFallRate: 0.5 }]
    expect(selectScalpFeedMarkets(tickers, { topN: 2 })).toHaveLength(2)
    expect(selectScalpFeedMarkets(tickers, { topN: 10 })).not.toContain("BTC-PERP")
  })
})

describe("scalpMarketEligible advisor feed", () => {
  it("evaluates feed markets under cap discipline without the env flag", () => {
    const feed = { isSelected: false, hasOpenPosition: false, openScalpCount: 0, inAdvisorFeed: true }
    expect(scalpMarketEligible(feed, { multiMarket: false, maxOpen: 3 })).toBe(true)
    // Cap and per-market position rules still bind feed markets.
    expect(scalpMarketEligible({ ...feed, openScalpCount: 3 }, { multiMarket: false, maxOpen: 3 })).toBe(false)
    expect(scalpMarketEligible({ ...feed, hasOpenPosition: true }, { multiMarket: false, maxOpen: 3 })).toBe(false)
  })

  it("leaves the single-market default untouched for non-feed markets", () => {
    const plain = { isSelected: false, hasOpenPosition: false, openScalpCount: 0 }
    expect(scalpMarketEligible(plain, { multiMarket: false, maxOpen: 3 })).toBe(false)
    expect(scalpMarketEligible({ ...plain, isSelected: true }, { multiMarket: false, maxOpen: 3 })).toBe(true)
  })
})

describe("scalpFeedChanged", () => {
  it("logs once per feed change, never for repeats or empty sets", () => {
    // First sighting logs.
    let s = scalpFeedChanged("", new Set(["INJ_USDT"]))
    expect(s.changed).toBe(true)
    // Same set next tick: silent.
    expect(scalpFeedChanged(s.key, new Set(["INJ_USDT"])).changed).toBe(false)
    // Order-insensitive: same members, different order: silent.
    expect(scalpFeedChanged("A,B", new Set(["B", "A"])).changed).toBe(false)
    // Changed membership logs.
    expect(scalpFeedChanged(s.key, new Set(["INJ_USDT", "SUI_USDT"])).changed).toBe(true)
    // Empty set never logs, and resets so the next set logs again.
    const empty = scalpFeedChanged(s.key, new Set<string>())
    expect(empty.changed).toBe(false)
    expect(scalpFeedChanged(empty.key, new Set(["INJ_USDT"])).changed).toBe(true)
  })
})

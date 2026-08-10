// Sniper Engine v1: event-driven dislocation detector.
// Fires ONLY on statistically extreme setups. Asymmetric R:R, hard invalidation.
import type { Candle } from "./mexc/public"
import { fetchTicker } from "./mexc/public"
import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { fetchTicker } from "./mexc/public"
import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { fetchTicker } from "./mexc/public"
import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { fetchTicker } from "./mexc/public"
import { db } from "./db"
import { classifierDecisions } from "./db/schema"
import { and, eq, isNull } from "drizzle-orm"
import type { IndicatorSnapshot } from "./indicators"

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

function avg(nums: number[]): number { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0 }

export function detectSniper(candles: Candle[], snap: IndicatorSnapshot, fundingRate = 0): SniperSignal {
  const none: SniperSignal = { direction: null, reason: "no dislocation", confidence: 0, stopLoss: 0, takeProfit: 0 }
  if (candles.length < 60) return none
  const last = candles[candles.length - 1]
  const prev = candles.slice(-SWEEP_LOOKBACK - 1, -1)
  const swingLow = Math.min(...prev.map(c => c.low))
  const swingHigh = Math.max(...prev.map(c => c.high))
  const avgVol = avg(prev.map(c => c.volume))
  const volSurge = avgVol > 0 ? last.volume / avgVol : 1

  // Detector 1: Liquidity sweep + reclaim (stop-hunt reversion)
  const bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= VOLUME_SURGE_MULT
  const bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && volSurge >= VOLUME_SURGE_MULT

  // Detector 2: Sigma exhaustion (black-swan / liquidation cascade fade)
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

  if (bullishReclaim) { direction = "long"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; reason = `Liquidity sweep: pierced ${swingLow.toFixed(6)} then reclaimed w/ ${volSurge.toFixed(1)}x volume`; extreme = last.low }
  else if (bearishReclaim) { direction = "short"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; reason = `Liquidity sweep: pierced ${swingHigh.toFixed(6)} then rejected w/ ${volSurge.toFixed(1)}x volume`; extreme = last.high }
  else if (exhaustedDown) { direction = "long"; confidence = 0.65; reason = `Sigma exhaustion: z=${z.toFixed(1)} crash w/ bullish reversal candle`; extreme = last.low }
  else if (exhaustedUp) { direction = "short"; confidence = 0.65; reason = `Sigma exhaustion: z=${z.toFixed(1)} blow-off w/ bearish reversal candle`; extreme = last.high }
  if (!direction) return none

  // Detector 3: funding crowded confluence boost
  if (direction === "short" && fundingRate > 0.0005) { confidence += 0.1; reason += " + crowded longs (funding)" }
  if (direction === "long" && fundingRate < -0.0005) { confidence += 0.1; reason += " + crowded shorts (funding)" }

  // Asymmetric risk: stop just beyond the swept extreme, TP = 3R
  const entry = last.close
  const stopLoss = direction === "long" ? Math.min(extreme, last.low) * 0.998 : Math.max(extreme, last.high) * 1.002
  const risk = Math.abs(entry - stopLoss)
  if (risk <= 0) return none
  const takeProfit = direction === "long" ? entry + risk * 3 : entry - risk * 3
  return { direction, reason, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit }
}

// ── Exchange-wide rotation sweep (observe-only) ─────────────────────────
// Phase 1: cheap ticker pre-filter across ALL MEXC futures.
// Phase 2: deep 15m kline scan on the shortlist only.
import { log as sweepLog } from "./grid"

const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000
let sweepRunning = false
let lastSweepTs = 0

export function maybeScanExchange(): void {
  const now = Date.now()
  if (sweepRunning || now - lastSweepTs < SWEEP_MIN_INTERVAL_MS) return
  lastSweepTs = now
  sweepRunning = true
  scanExchangeSniper()
    .catch((err) => console.error(`[Sniper] exchange sweep failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { sweepRunning = false })
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal): Promise<void> {
  await db.insert(classifierDecisions).values({
    symbol, timeframe, candleTime,
    candidateDirection: sig.direction ?? "long",
    strategy: "sniper",
    regime: "dislocation",
    entryPrice: entry,
    confirmationMode: "observe",
    logisticAllowed: false,
    logisticConfidence: sig.confidence,
    lorentzianDirection: sig.direction ?? "long",
    lorentzianVote: 1,
    lorentzianConfidence: sig.confidence,
    lorentzianAllowed: true,
    lorentzianFilters: { stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, reason: sig.reason },
    finalAllowed: false,
    reason: sig.reason,
  })
}

export async function resolveSniperDecisions(): Promise<number> {
  const rows = await db.select().from(classifierDecisions)
    .where(and(eq(classifierDecisions.strategy, "sniper"), isNull(classifierDecisions.resolvedAt)))
  let resolved = 0
  for (const r of rows) {
    const f = (r.lorentzianFilters ?? {}) as any
    const sl = f.stopLoss as number
    const tp = f.takeProfit as number
    if (!sl || !tp) continue
    let price = 0
    try { price = (await fetchTicker(r.symbol)).lastPrice } catch { continue }
    const dir = r.candidateDirection as "long" | "short"
    const ageMin = (Date.now() - new Date(r.createdAt as any).getTime()) / 60000
    let outcome: "tp" | "sl" | "exp" | null = null
    if (dir === "long") { if (price >= tp) outcome = "tp"; else if (price <= sl) outcome = "sl" }
    else { if (price <= tp) outcome = "tp"; else if (price >= sl) outcome = "sl" }
    if (!outcome && ageMin > 180) outcome = "exp" // 12 x Min15 bars time-stop
    if (!outcome) continue
    const retPct = dir === "long" ? ((price - r.entryPrice) / r.entryPrice) * 100 : ((r.entryPrice - price) / r.entryPrice) * 100
    const win = outcome === "tp" ? true : outcome === "sl" ? false : retPct > 0
    await db.update(classifierDecisions).set({
      resolvedAt: new Date(),
      outcomeDirection: dir,
      outcomeReturn: parseFloat(retPct.toFixed(2)),
      outcomeCorrectLogistic: win,
      outcomeCorrectLorentzian: win,
    }).where(eq(classifierDecisions.id, r.id))
    resolved++
    console.log(`[Sniper] RESOLVED ${r.symbol} ${dir}: ${outcome} (${retPct.toFixed(2)}%)`)
  }
  return resolved
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal): Promise<void> {
  await db.insert(classifierDecisions).values({
    symbol, timeframe, candleTime,
    candidateDirection: sig.direction ?? "long",
    strategy: "sniper",
    regime: "dislocation",
    entryPrice: entry,
    confirmationMode: "observe",
    logisticAllowed: false,
    logisticConfidence: sig.confidence,
    lorentzianDirection: sig.direction ?? "long",
    lorentzianVote: 1,
    lorentzianConfidence: sig.confidence,
    lorentzianAllowed: true,
    lorentzianFilters: { stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, reason: sig.reason },
    finalAllowed: false,
    reason: sig.reason,
  })
}

export async function resolveSniperDecisions(): Promise<number> {
  const rows = await db.select().from(classifierDecisions)
    .where(and(eq(classifierDecisions.strategy, "sniper"), isNull(classifierDecisions.resolvedAt)))
  let resolved = 0
  for (const r of rows) {
    const f = (r.lorentzianFilters ?? {}) as any
    const sl = f.stopLoss as number
    const tp = f.takeProfit as number
    if (!sl || !tp) continue
    let price = 0
    try { price = (await fetchTicker(r.symbol)).lastPrice } catch { continue }
    const dir = r.candidateDirection as "long" | "short"
    const ageMin = (Date.now() - new Date(r.createdAt as any).getTime()) / 60000
    let outcome: "tp" | "sl" | "exp" | null = null
    if (dir === "long") { if (price >= tp) outcome = "tp"; else if (price <= sl) outcome = "sl" }
    else { if (price <= tp) outcome = "tp"; else if (price >= sl) outcome = "sl" }
    if (!outcome && ageMin > 180) outcome = "exp" // 12 x Min15 bars time-stop
    if (!outcome) continue
    const retPct = dir === "long" ? ((price - r.entryPrice) / r.entryPrice) * 100 : ((r.entryPrice - price) / r.entryPrice) * 100
    const win = outcome === "tp" ? true : outcome === "sl" ? false : retPct > 0
    await db.update(classifierDecisions).set({
      resolvedAt: new Date(),
      outcomeDirection: dir,
      outcomeReturn: parseFloat(retPct.toFixed(2)),
      outcomeCorrectLogistic: win,
      outcomeCorrectLorentzian: win,
    }).where(eq(classifierDecisions.id, r.id))
    resolved++
    console.log(`[Sniper] RESOLVED ${r.symbol} ${dir}: ${outcome} (${retPct.toFixed(2)}%)`)
  }
  return resolved
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal): Promise<void> {
  await db.insert(classifierDecisions).values({
    symbol, timeframe, candleTime,
    candidateDirection: sig.direction ?? "long",
    strategy: "sniper",
    regime: "dislocation",
    entryPrice: entry,
    confirmationMode: "observe",
    logisticAllowed: false,
    logisticConfidence: sig.confidence,
    lorentzianDirection: sig.direction ?? "long",
    lorentzianVote: 1,
    lorentzianConfidence: sig.confidence,
    lorentzianAllowed: true,
    lorentzianFilters: { stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, reason: sig.reason },
    finalAllowed: false,
    reason: sig.reason,
  })
}

export async function resolveSniperDecisions(): Promise<number> {
  const rows = await db.select().from(classifierDecisions)
    .where(and(eq(classifierDecisions.strategy, "sniper"), isNull(classifierDecisions.resolvedAt)))
  let resolved = 0
  for (const r of rows) {
    const f = (r.lorentzianFilters ?? {}) as any
    const sl = f.stopLoss as number
    const tp = f.takeProfit as number
    if (!sl || !tp) continue
    let price = 0
    try { price = (await fetchTicker(r.symbol)).lastPrice } catch { continue }
    const dir = r.candidateDirection as "long" | "short"
    const ageMin = (Date.now() - new Date(r.createdAt as any).getTime()) / 60000
    let outcome: "tp" | "sl" | "exp" | null = null
    if (dir === "long") { if (price >= tp) outcome = "tp"; else if (price <= sl) outcome = "sl" }
    else { if (price <= tp) outcome = "tp"; else if (price >= sl) outcome = "sl" }
    if (!outcome && ageMin > 180) outcome = "exp" // 12 x Min15 bars time-stop
    if (!outcome) continue
    const retPct = dir === "long" ? ((price - r.entryPrice) / r.entryPrice) * 100 : ((r.entryPrice - price) / r.entryPrice) * 100
    const win = outcome === "tp" ? true : outcome === "sl" ? false : retPct > 0
    await db.update(classifierDecisions).set({
      resolvedAt: new Date(),
      outcomeDirection: dir,
      outcomeReturn: parseFloat(retPct.toFixed(2)),
      outcomeCorrectLogistic: win,
      outcomeCorrectLorentzian: win,
    }).where(eq(classifierDecisions.id, r.id))
    resolved++
    console.log(`[Sniper] RESOLVED ${r.symbol} ${dir}: ${outcome} (${retPct.toFixed(2)}%)`)
  }
  return resolved
}

export async function recordSniperCandidate(symbol: string, timeframe: string, candleTime: number, entry: number, sig: SniperSignal): Promise<void> {
  await db.insert(classifierDecisions).values({
    symbol, timeframe, candleTime,
    candidateDirection: sig.direction ?? "long",
    strategy: "sniper",
    regime: "dislocation",
    entryPrice: entry,
    confirmationMode: "observe",
    logisticAllowed: false,
    logisticConfidence: sig.confidence,
    lorentzianDirection: sig.direction ?? "long",
    lorentzianVote: 1,
    lorentzianConfidence: sig.confidence,
    lorentzianAllowed: true,
    lorentzianFilters: { stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, reason: sig.reason },
    finalAllowed: false,
    reason: sig.reason,
  })
}

export async function resolveSniperDecisions(): Promise<number> {
  const rows = await db.select().from(classifierDecisions)
    .where(and(eq(classifierDecisions.strategy, "sniper"), isNull(classifierDecisions.resolvedAt)))
  let resolved = 0
  for (const r of rows) {
    const f = (r.lorentzianFilters ?? {}) as any
    const sl = f.stopLoss as number
    const tp = f.takeProfit as number
    if (!sl || !tp) continue
    let price = 0
    try { price = (await fetchTicker(r.symbol)).lastPrice } catch { continue }
    const dir = r.candidateDirection as "long" | "short"
    const ageMin = (Date.now() - new Date(r.createdAt as any).getTime()) / 60000
    let outcome: "tp" | "sl" | "exp" | null = null
    if (dir === "long") { if (price >= tp) outcome = "tp"; else if (price <= sl) outcome = "sl" }
    else { if (price <= tp) outcome = "tp"; else if (price >= sl) outcome = "sl" }
    if (!outcome && ageMin > 180) outcome = "exp" // 12 x Min15 bars time-stop
    if (!outcome) continue
    const retPct = dir === "long" ? ((price - r.entryPrice) / r.entryPrice) * 100 : ((r.entryPrice - price) / r.entryPrice) * 100
    const win = outcome === "tp" ? true : outcome === "sl" ? false : retPct > 0
    await db.update(classifierDecisions).set({
      resolvedAt: new Date(),
      outcomeDirection: dir,
      outcomeReturn: parseFloat(retPct.toFixed(2)),
      outcomeCorrectLogistic: win,
      outcomeCorrectLorentzian: win,
    }).where(eq(classifierDecisions.id, r.id))
    resolved++
    console.log(`[Sniper] RESOLVED ${r.symbol} ${dir}: ${outcome} (${retPct.toFixed(2)}%)`)
  }
  return resolved
}

export async function scanExchangeSniper(): Promise<number> {
  await resolveSniperDecisions().catch(() => {})
  await resolveSniperDecisions().catch(() => {})
  await resolveSniperDecisions().catch(() => {})
  await resolveSniperDecisions().catch(() => {})
  const res = await fetch("https://contract.mexc.com/api/v1/contract/ticker", { cache: "no-store" })
  const json = (await res.json()) as any
  if (!json.success || !Array.isArray(json.data)) return 0
  const candidates = (json.data as any[])
    .filter((t) => t.symbol.endsWith("_USDT") && !t.symbol.includes("STOCK") && !t.symbol.includes("3L") && !t.symbol.includes("3S"))
    .filter((t) => (t.amount24 ?? 0) > 20000000)
    .filter((t) => Math.abs(t.riseFallRate ?? 0) > 0.02 || Math.abs(t.fundingRate ?? 0) > 0.0004)
    .map((t) => ({
      symbol: t.symbol as string,
      funding: Number(t.fundingRate ?? 0),
      score:
        Math.abs(Number(t.riseFallRate ?? 0)) * Math.log10(Math.max(10, Number(t.amount24 ?? 10) / 1e6)) +
        Math.abs(Number(t.fundingRate ?? 0)) * 50,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
  let found = 0
  for (const c of candidates) {
    try {
      const end = Math.floor(Date.now() / 1000)
      const start = end - 2 * 24 * 3600
      const kres = await fetch(
        `https://contract.mexc.com/api/v1/contract/kline/${c.symbol}?interval=Min15&start=${start}&end=${end}`,
        { cache: "no-store" }
      )
      const kj = (await kres.json()) as any
      if (!kj.success || !kj.data?.time?.length) continue
      const { time, open, high, low, close, vol } = kj.data
      const candles: Candle[] = []
      for (let i = 0; i < time.length; i++) {
        candles.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
      }
      const sig = detectSniper(candles, null as any, c.funding)
      if (sig.direction) {
        found++
        const cool = ((globalThis as any).__sniperLast ?? {})[c.symbol] ?? 0
        if (Date.now() - cool > 6 * 3600 * 1000) {
          ;(globalThis as any).__sniperLast = { ...((globalThis as any).__sniperLast ?? {}), [c.symbol]: Date.now() }
          await sweepLog(
            "info",
            `🎯 SNIPER CANDIDATE ${c.symbol}: ${sig.direction.toUpperCase()} | ${sig.reason} | conf ${(sig.confidence * 100).toFixed(0)}% | SL ${sig.stopLoss.toFixed(6)} | TP ${sig.takeProfit.toFixed(6)}`
          )
        }
      }
      await new Promise((r) => setTimeout(r, 80))
    } catch {
      continue
    }
  }
  console.log(`[Sniper] exchange sweep: ${candidates.length} names deep-scanned, ${found} candidate(s)`)
  return found
}

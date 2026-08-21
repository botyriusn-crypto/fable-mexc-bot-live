// backtest-advanced.ts — replay historical klines through the REAL signal chain
// (evaluateEntry → evaluateAdvancedEntry → computeInitialStops → evaluateExit)
// and report win rate, expectancy, Sharpe, max drawdown, profit factor, and a
// per-strategy breakdown.
//
// Usage:
//   tsx backtest-advanced.ts --symbol BTC_USDT --timeframe Min5 --days 30
//   tsx backtest-advanced.ts --symbol BTC_USDT --timeframe Min5 --days 30 --advanced
//   tsx backtest-advanced.ts --symbol BTC_USDT --timeframe Min5 --days 30 --compare
//   tsx backtest-advanced.ts --symbol BTC_USDT --timeframe Min5 --days 30 --compare --partial
//   tsx backtest-advanced.ts --symbol BTC_USDT --timeframe Min5 --days 30 --advanced --partial --partial-fraction 0.5 --partial-atr 1.0
//
// Honest limitations (documented, not hidden):
//   - The ML gate (gateEntry) is live-trained and cannot be replayed, so it is
//     stubbed to a neutral pass-through (zero-weight model → confidence 0.5).
//   - Smart-money legs (funding / CVD / taker / OI) are real-time-only and have
//     no historical source on MEXC's public API, so they are DISABLED in
//     backtest mode and marked "not measured" in the report.

import { computeSnapshot } from "./lib/indicators"
import { evaluateEntry, isOppositeSignal } from "./lib/strategy"
import {
  evaluateAdvancedEntry,
  DEFAULT_ADVANCED_CONFIG,
  type AdvancedConfig,
} from "./lib/advanced-strategy"
import { computeInitialStops, evaluateExit } from "./lib/exits"
import type { Candle } from "./lib/mexc/public"
import type { MlState } from "./lib/ml"
import type { BotConfig } from "./lib/db/schema"

// ── CLI ──────────────────────────────────────────────────────────────────────
interface CliArgs {
  symbol: string
  timeframe: string
  days: number
  advanced: boolean
  compare: boolean
  htf: string
  leverage: number
  partial: boolean
  partialFraction: number
  partialAtrMult: number
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    symbol: "BTC_USDT",
    timeframe: "Min5",
    days: 30,
    advanced: false,
    compare: false,
    htf: "Min60",
    leverage: 5,
    partial: false,
    partialFraction: 0.5,
    partialAtrMult: 1.0,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    switch (k) {
      case "--symbol": a.symbol = v; i++; break
      case "--timeframe": a.timeframe = v; i++; break
      case "--days": a.days = Number(v); i++; break
      case "--advanced": a.advanced = true; break
      case "--compare": a.compare = true; break
      case "--htf": a.htf = v; i++; break
      case "--leverage": a.leverage = Number(v); i++; break
      case "--partial": a.partial = true; break
      case "--partial-fraction": a.partialFraction = Number(v); i++; break
      case "--partial-atr": a.partialAtrMult = Number(v); i++; break
    }
  }
  return a
}

// ── Data fetch (self-contained; fetchKlines only returns recent candles) ─────
const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60, Min3: 180, Min5: 300, Min15: 900, Min30: 1800,
  Min60: 3600, Hour1: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400,
}
const BASE_URL = "https://api.mexc.com/api/v1/contract"

async function fetchKlinesRange(
  symbol: string,
  interval: string,
  startSec: number,
  endSec: number,
): Promise<Candle[]> {
  const seconds = INTERVAL_SECONDS[interval]
  if (!seconds) throw new Error(`Unknown interval: ${interval}`)
  const CHUNK = 1000
  const out: Candle[] = []
  let cursor = startSec
  while (cursor < endSec) {
    const chunkEnd = Math.min(cursor + seconds * CHUNK, endSec)
    const url = `${BASE_URL}/kline/${symbol}?interval=${interval}&start=${cursor}&end=${chunkEnd}`
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) throw new Error(`kline fetch failed: ${res.status}`)
    const json = await res.json()
    if (!json.success || !json.data) throw new Error("kline response unsuccessful")
    const { time, open, high, low, close, vol } = json.data
    for (let i = 0; i < time.length; i++) {
      out.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] })
    }
    cursor = chunkEnd
  }
  const seen = new Map<number, Candle>()
  for (const c of out) seen.set(c.time, c)
  return [...seen.values()].sort((a, b) => a.time - b.time)
}

// ── Config ───────────────────────────────────────────────────────────────────
function buildConfig(a: CliArgs): BotConfig {
  return {
    symbol: a.symbol,
    timeframe: a.timeframe,
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    atrPeriod: 14,
    strategyMode: "auto",
    adxTrendThreshold: 25,
    adxRangeThreshold: 20,
    bbPeriod: 20,
    bbStd: 2,
    slAtrMult: 1.5,
    tpAtrMult: 2.5,
    trailAtrMult: 1.2,
    momentumThreshold: 0.6,
    mlConfidenceThreshold: 0.5, // neutral → ML gate passes everything
    allowLong: true,
    allowShort: true,
    leverage: a.leverage,
    positionSizeUsdt: 500,
    sniperMomentumThreshold: 0.7,
    sniperTrailAtrMult: 0.6,
    partialTakeEnabled: a.partial,
    partialFraction: a.partialFraction,
    partialAtrMult: a.partialAtrMult,
  } as BotConfig
}

function buildAdvancedConfig(a: CliArgs): AdvancedConfig {
  return {
    ...DEFAULT_ADVANCED_CONFIG,
    enabled: true,
    htfTimeframe: a.htf,
    smartMoneyEnabled: false, // not backtestable — real-time only
  }
}

// Zero-weight model → predict() returns sigmoid(0) = 0.5 → gateEntry passes all.
const STUB_MODEL: MlState = {
  weights: {},
  bias: 0,
  sampleCount: 0,
  correctCount: 0,
  rollingAccuracy: 0.5,
}

// ── Simulation ───────────────────────────────────────────────────────────────
interface SimPosition {
  side: "long" | "short"
  entryPrice: number
  stopLoss: number | null
  takeProfit: number | null
  trailingStop: number | null
  trailingActive: boolean
  breakEvenMoved: boolean
  highestPrice: number
  lowestPrice: number
  atrAtEntry: number
  strategy: string
  sizeUsdt: number
  quantity: number
  remainingQuantity: number
  partialTaken: boolean
  leverage: number
  entryBar: number
  entryConfidence: number
}

interface TradeResult {
  side: "long" | "short"
  strategy: string
  entryPrice: number
  exitPrice: number
  pnl: number
  pnlPct: number
  reason: string
  barsHeld: number
}

const TAKER_FEE = 0.0002

function runBacktest(
  candles: Candle[],
  htfCandles: Candle[],
  cfg: BotConfig,
  advCfg: AdvancedConfig | null,
  initialEquity: number,
): { trades: TradeResult[]; equityCurve: number[] } {
  const WARMUP = 100
  const trades: TradeResult[] = []
  let equity = initialEquity
  const equityCurve: number[] = [equity]
  let pos: SimPosition | null = null

  for (let i = WARMUP; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, cfg)
    const price = snap.price

    // Manage open position
    if (pos) {
      const opposite = isOppositeSignal(snap, pos.side)
      const decision = evaluateExit(pos as any, snap, cfg, opposite)
      const u = decision.updates
      if (u.stopLoss != null) pos.stopLoss = u.stopLoss
      if (u.trailingStop != null) pos.trailingStop = u.trailingStop
      if (u.trailingActive != null) pos.trailingActive = u.trailingActive
      if (u.breakEvenMoved != null) pos.breakEvenMoved = u.breakEvenMoved
      if (u.highestPrice != null) pos.highestPrice = u.highestPrice
      if (u.lowestPrice != null) pos.lowestPrice = u.lowestPrice

      // Partial profit taking: once price reaches entry ± partialAtrMult×ATR in
      // the favorable direction, book a fraction of the position, move the stop
      // to break-even, and let the remainder run to the original TP/trail.
      if (cfg.partialTakeEnabled && !pos.partialTaken) {
        const dir = pos.side === "long" ? 1 : -1
        const partialTarget = pos.entryPrice + dir * pos.atrAtEntry * cfg.partialAtrMult
        const hit = pos.side === "long" ? price >= partialTarget : price <= partialTarget
        if (hit) {
          const closeQty = pos.quantity * cfg.partialFraction
          const grossPnl = (price - pos.entryPrice) * dir * closeQty
          const closeFee = pos.sizeUsdt * pos.leverage * TAKER_FEE * cfg.partialFraction
          const netPnl = grossPnl - closeFee
          equity += netPnl
          trades.push({
            side: pos.side,
            strategy: pos.strategy,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            pnl: netPnl,
            pnlPct: (netPnl / (pos.sizeUsdt * cfg.partialFraction)) * 100,
            reason: "partial",
            barsHeld: i - pos.entryBar,
          })
          pos.remainingQuantity -= closeQty
          pos.partialTaken = true
          pos.stopLoss = pos.entryPrice // break-even on the remainder
          pos.breakEvenMoved = true
        }
      }

      if (decision.action === "close") {
        const dir = pos.side === "long" ? 1 : -1
        const remainingQty = pos.remainingQuantity
        const remainingSize = pos.sizeUsdt * (remainingQty / pos.quantity)
        const grossPnl = (price - pos.entryPrice) * dir * remainingQty
        const closeFee = remainingSize * pos.leverage * TAKER_FEE
        const netPnl = grossPnl - closeFee
        equity += netPnl
        trades.push({
          side: pos.side,
          strategy: pos.strategy,
          entryPrice: pos.entryPrice,
          exitPrice: price,
          pnl: netPnl,
          pnlPct: (netPnl / remainingSize) * 100,
          reason: decision.reason ?? "unknown",
          barsHeld: i - pos.entryBar,
        })
        pos = null
      }
    }

    // Entry (only if flat)
    if (!pos) {
      const signal = evaluateEntry(snap, window, cfg, STUB_MODEL, equity)
      if (signal.direction) {
        let direction = signal.direction
        let confidence = signal.confidence
        let sizeUsdt = signal.dynamicSize ?? cfg.positionSizeUsdt

        if (advCfg) {
          const candlesByTf: Record<string, Candle[]> = { [cfg.timeframe]: window }
          if (htfCandles.length) candlesByTf[advCfg.htfTimeframe] = htfCandles.slice(0, i + 1)
          const adv = evaluateAdvancedEntry(
            direction, confidence, candlesByTf, {}, equity, snap.atr, price, advCfg,
          )
          if (!adv.passed || !adv.direction) continue
          direction = adv.direction
          confidence = adv.confidence
          if (adv.sizeUsdt != null) sizeUsdt = adv.sizeUsdt
        }

        const stops = computeInitialStops(direction, price, snap.atr, cfg)
        const quantity = (sizeUsdt * cfg.leverage) / price
        pos = {
          side: direction,
          entryPrice: price,
          stopLoss: stops.stopLoss,
          takeProfit: stops.takeProfit,
          trailingStop: null,
          trailingActive: false,
          breakEvenMoved: false,
          highestPrice: price,
          lowestPrice: price,
          atrAtEntry: snap.atr,
          strategy: signal.strategy,
          sizeUsdt,
          quantity,
          remainingQuantity: quantity,
          partialTaken: false,
          leverage: cfg.leverage,
          entryBar: i,
          entryConfidence: confidence,
        }
      }
    }

    equityCurve.push(equity)
  }

  return { trades, equityCurve }
}

// ── Metrics ──────────────────────────────────────────────────────────────────
interface Metrics {
  n: number
  winRate: number
  avgWin: number
  avgLoss: number
  expectancy: number
  profitFactor: number
  totalPnl: number
  sharpe: number
  maxDd: number
}

function computeMetrics(trades: TradeResult[], equityCurve: number[]): Metrics | null {
  const n = trades.length
  if (n === 0) return null
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const winRate = wins.length / n
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const avgWin = wins.length ? grossProfit / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)

  const pnls = trades.map((t) => t.pnl)
  const mean = totalPnl / n
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? mean / std : 0

  let peak = -Infinity
  let maxDd = 0
  for (const e of equityCurve) {
    peak = Math.max(peak, e)
    maxDd = Math.max(maxDd, (peak - e) / peak)
  }

  return { n, winRate, avgWin, avgLoss, expectancy, profitFactor, totalPnl, sharpe, maxDd }
}

function strategyBreakdown(trades: TradeResult[]): { strategy: string; n: number; winRate: number; totalPnl: number }[] {
  const by = new Map<string, TradeResult[]>()
  for (const t of trades) {
    const arr = by.get(t.strategy) ?? []
    arr.push(t)
    by.set(t.strategy, arr)
  }
  return [...by.entries()].map(([strategy, ts]) => {
    const wins = ts.filter((t) => t.pnl > 0).length
    return {
      strategy,
      n: ts.length,
      winRate: ts.length ? wins / ts.length : 0,
      totalPnl: ts.reduce((s, t) => s + t.pnl, 0),
    }
  })
}

// ── Report ───────────────────────────────────────────────────────────────────
function printReport(title: string, res: { trades: TradeResult[]; equityCurve: number[] }, initialEquity: number) {
  const m = computeMetrics(res.trades, res.equityCurve)
  console.log(`\n══════════════════════════════════════════════════════`)
  console.log(`  ${title}`)
  console.log(`══════════════════════════════════════════════════════`)
  if (!m) {
    console.log("  No trades generated.")
    return
  }
  console.log(`  Trades:            ${m.n}`)
  console.log(`  Win rate:          ${(m.winRate * 100).toFixed(1)}%`)
  console.log(`  Avg win:           ${m.avgWin.toFixed(2)} USDT`)
  console.log(`  Avg loss:          ${m.avgLoss.toFixed(2)} USDT`)
  console.log(`  Expectancy:        ${m.expectancy.toFixed(2)} USDT/trade`)
  console.log(`  Profit factor:     ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:         ${m.totalPnl.toFixed(2)} USDT (${((m.totalPnl / initialEquity) * 100).toFixed(1)}%)`)
  console.log(`  Sharpe (per-trade):${m.sharpe.toFixed(3)}`)
  console.log(`  Max drawdown:      ${(m.maxDd * 100).toFixed(1)}%`)
  console.log(`\n  Per-strategy:`)
  for (const s of strategyBreakdown(res.trades)) {
    console.log(`    ${s.strategy.padEnd(8)} n=${s.n}  win=${(s.winRate * 100).toFixed(1)}%  pnl=${s.totalPnl.toFixed(2)}`)
  }
}

function printComparison(title: string, base: { trades: TradeResult[]; equityCurve: number[] }, adv: { trades: TradeResult[]; equityCurve: number[] }, initialEquity: number) {
  const b = computeMetrics(base.trades, base.equityCurve)
  const a = computeMetrics(adv.trades, adv.equityCurve)
  if (!b || !a) return
  console.log(`\n══════════════════════════════════════════════════════`)
  console.log(`  ${title}`)
  console.log(`══════════════════════════════════════════════════════`)
  const rows: [string, string, string][] = [
    ["Trades", String(b.n), String(a.n)],
    ["Win rate", `${(b.winRate * 100).toFixed(1)}%`, `${(a.winRate * 100).toFixed(1)}%`],
    ["Expectancy", b.expectancy.toFixed(2), a.expectancy.toFixed(2)],
    ["Profit factor", b.profitFactor === Infinity ? "∞" : b.profitFactor.toFixed(2), a.profitFactor === Infinity ? "∞" : a.profitFactor.toFixed(2)],
    ["Total PnL", b.totalPnl.toFixed(2), a.totalPnl.toFixed(2)],
    ["Max drawdown", `${(b.maxDd * 100).toFixed(1)}%`, `${(a.maxDd * 100).toFixed(1)}%`],
  ]
  for (const [label, bv, av] of rows) {
    console.log(`  ${label.padEnd(16)} ${bv.padEnd(12)} ${av}`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2))
  const endSec = Math.floor(Date.now() / 1000)
  const startSec = endSec - a.days * 86400

  console.log(`Fetching ${a.symbol} ${a.timeframe} for ${a.days} days...`)
  const candles = await fetchKlinesRange(a.symbol, a.timeframe, startSec, endSec)
  console.log(`Fetched ${candles.length} candles`)

  let htfCandles: Candle[] = []
  if (a.advanced || a.compare) {
    htfCandles = await fetchKlinesRange(a.symbol, a.htf, startSec, endSec)
    console.log(`Fetched ${htfCandles.length} HTF (${a.htf}) candles`)
  }

  const cfg = buildConfig(a)
  const initialEquity = 10000

  if (a.compare) {
    const baseCfg = { ...cfg, partialTakeEnabled: false }
    const advCfg = buildAdvancedConfig(a)
    const base = runBacktest(candles, htfCandles, baseCfg, null, initialEquity)
    const adv = runBacktest(candles, htfCandles, baseCfg, advCfg, initialEquity)
    printReport("BASELINE (base signal only)", base, initialEquity)
    printReport("ADVANCED (base + MTF confluence)", adv, initialEquity)
    if (a.partial) {
      const partialCfg = { ...cfg, partialTakeEnabled: true }
      const advPartial = runBacktest(candles, htfCandles, partialCfg, advCfg, initialEquity)
      printReport("ADVANCED + PARTIAL (MTF + partial take)", advPartial, initialEquity)
      printComparison("ADVANCED vs ADVANCED+PARTIAL", adv, advPartial, initialEquity)
    }
    printComparison("BASELINE vs ADVANCED", base, adv, initialEquity)
  } else {
    const advCfg = a.advanced ? buildAdvancedConfig(a) : null
    const res = runBacktest(candles, htfCandles, cfg, advCfg, initialEquity)
    printReport(a.advanced ? "ADVANCED (base + MTF)" : "BASELINE (base signal only)", res, initialEquity)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

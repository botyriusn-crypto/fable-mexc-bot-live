// backtest-advanced.ts — v2: audit-fixed replay harness for trend/range strategies.
//
// Fixes vs v1 (see WORKFLOW.md audit):
//   F1: entry fee + exit fee charged; slippage on market fills.
//   F2: intra-bar SL/TP/trail checks via candle high/low; conservative same-bar
//       rule (SL first, then trail, then TP); gap-aware fills.
//   F3: HTF window sliced by TIME, closed candles only (no future leak).
//   F6: entries fill at NEXT bar open + slippage (not signal-bar close).
//   F7: mark-to-market equity curve -> honest max drawdown.
//   F8: equity curve pushed every bar (no skips).
//   F5: config defaults mirror live config.json (with warnings). ML gate stays
//       neutral (threshold 0.5) — the live model cannot be replayed.
// Not modeled: funding, liquidation engine, order-book depth, maker fills.
//
// Usage:
//   npx tsx backtest-advanced.ts --symbol WLD_USDT --timeframe Min15 --days 60 --matrix
//   npx tsx backtest-advanced.ts --symbol WLD_USDT --timeframe Min15 --days 60 --compare
//   npx tsx backtest-advanced.ts --symbol WLD_USDT --timeframe Min15 --days 60 --gate on
//   Optional: --dump file.csv --fees 0.0002 --slippage 0.0003 --leverage 3
//             --adx-range 20 --equity 10000 --htf Min60

import * as fs from "node:fs"
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
  htf: string
  leverage: number | null
  gate: boolean
  exits: "adaptive" | "fixed" | "trailonly"
  compare: boolean
  offsetDays: number
  strategy: string
  makerEntry: boolean
  matrix: boolean
  dump: string | null
  fees: number
  slippage: number
  equity: number
  adxRange: number | null
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    symbol: "BTC_USDT", timeframe: "Min15", days: 60, htf: "Min60",
    leverage: null, gate: false, exits: "adaptive", compare: false, matrix: false,
    dump: null, fees: 0.0002, slippage: 0.0003, equity: 10000, adxRange: null, offsetDays: 0,
    strategy: "auto", makerEntry: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    switch (k) {
      case "--symbol": a.symbol = v; i++; break
      case "--timeframe": a.timeframe = v; i++; break
      case "--days": a.days = Number(v); i++; break
      case "--htf": a.htf = v; i++; break
      case "--leverage": a.leverage = Number(v); i++; break
      case "--gate": a.gate = !(v === "off" || v === "false"); i++; break
      case "--exits": a.exits = v === "fixed" ? "fixed" : v === "trailonly" ? "trailonly" : "adaptive"; i++; break
      case "--offset-days": a.offsetDays = Number(v); i++; break
      case "--strategy": a.strategy = v; i++; break
      case "--maker-entry": a.makerEntry = true; break
      case "--compare": a.compare = true; break
      case "--matrix": a.matrix = true; break
      case "--dump": a.dump = v; i++; break
      case "--fees": a.fees = Number(v); i++; break
      case "--slippage": a.slippage = Number(v); i++; break
      case "--equity": a.equity = Number(v); i++; break
      case "--adx-range": a.adxRange = Number(v); i++; break
    }
  }
  return a
}

// ── Data fetch ───────────────────────────────────────────────────────────────
const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60, Min3: 180, Min5: 300, Min15: 900, Min30: 1800,
  Min60: 3600, Hour1: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400,
}
const BASE_URL = "https://api.mexc.com/api/v1/contract"

async function fetchKlinesRange(
  symbol: string, interval: string, startSec: number, endSec: number,
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

// ── Config (live parity) ─────────────────────────────────────────────────────
function loadLiveConfig(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync("config.json", "utf8")) } catch { return {} }
}

function buildConfig(a: CliArgs): BotConfig {
  const live = loadLiveConfig()
  const leverage = a.leverage ?? (typeof live.leverage === "number" ? live.leverage : 3)
  const cfg = {
    symbol: a.symbol,
    timeframe: a.timeframe,
    emaFast: live.emaFast ?? 9,
    emaSlow: live.emaSlow ?? 21,
    rsiPeriod: live.rsiPeriod ?? 14,
    rsiOverbought: live.rsiOverbought ?? 70,
    rsiOversold: live.rsiOversold ?? 30,
    atrPeriod: live.atrPeriod ?? 14,
    strategyMode: a.strategy === "trend" || a.strategy === "range" ? a.strategy : "auto",
    adxTrendThreshold: live.adxTrendThreshold ?? 25,
    adxRangeThreshold: a.adxRange ?? live.adxRangeThreshold ?? 20,
    bbPeriod: live.bbPeriod ?? 20,
    bbStd: live.bbStd ?? 2,
    slAtrMult: live.slAtrMult ?? 1.5,
    tpAtrMult: live.tpAtrMult ?? 2.5,
    trailAtrMult: live.trailAtrMult ?? 1.2,
    momentumThreshold: live.momentumThreshold ?? 0.6,
    mlConfidenceThreshold: 0.5, // neutral: stub model must pass everything
    allowLong: true,
    allowShort: true,
    leverage,
    positionSizeUsdt: live.positionSizeUsdt ?? 500,
    partialTakeEnabled: false,
  } as BotConfig
  console.log(`  Config: EMA ${cfg.emaFast}/${cfg.emaSlow}  RSI ${cfg.rsiOversold}/${cfg.rsiOverbought}  ADX t/r ${cfg.adxTrendThreshold}/${cfg.adxRangeThreshold}  SL/TP ${cfg.slAtrMult}/${cfg.tpAtrMult}xATR  trail ${cfg.trailAtrMult}xATR  lev ${cfg.leverage}x  fees ${(a.fees * 100).toFixed(3)}%  slip ${(a.slippage * 100).toFixed(3)}%  (live parity; ML gate neutral)`)
  if (cfg.adxRangeThreshold >= cfg.adxTrendThreshold) {
    console.log(`  !! F9 WARNING: adxRangeThreshold (${cfg.adxRangeThreshold}) >= adxTrendThreshold (${cfg.adxTrendThreshold})`)
    console.log(`     -> "neutral" regime is IMPOSSIBLE; the live bot never stands aside.`)
    console.log(`     -> Re-run with --adx-range 20 to quantify what the neutral zone restores.`)
  }
  return cfg
}

// Zero-weight model -> predict() returns 0.5 -> ML gate passes all (documented stub).
const STUB_MODEL: MlState = {
  weights: {}, bias: 0, sampleCount: 0, correctCount: 0, rollingAccuracy: 0.5,
}

// ── Simulation ───────────────────────────────────────────────────────────────
interface PendingEntry {
  side: "long" | "short"
  strategy: string
  confidence: number
  sizeUsdt: number
  atr: number
  signalBar: number
  signalTime: number
}

interface SimPosition {
  side: "long" | "short"
  strategy: string
  confidence: number
  signalTime: number
  signalBar: number
  entryBar: number
  entryTime: number
  entryPrice: number
  stopLoss: number
  takeProfit: number
  trailingStop: number | null
  trailingActive: boolean
  breakEvenMoved: boolean
  highestPrice: number
  lowestPrice: number
  atrAtEntry: number
  sizeUsdt: number
  leverage: number
  quantity: number
  notional: number
  initialRiskPerUnit: number
  entryFee: number
  maeR: number
  mfeR: number
}

interface Trade {
  side: "long" | "short"
  strategy: string
  reason: string
  signalTime: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  quantity: number
  notional: number
  fees: number
  pnl: number
  r: number
  maeR: number
  mfeR: number
  barsHeld: number
  confidence: number
}

interface RunOpts {
  gate: boolean
  exits: "adaptive" | "fixed" | "trailonly"
  makerEntry: boolean
  takerFee: number
  slippage: number
  initialEquity: number
}

interface SimResult {
  trades: Trade[]
  equityCurve: number[]
  gateCandidates: number
  gateBlocked: number
}

function simulate(
  candles: Candle[],
  htfCandles: Candle[],
  cfg: BotConfig,
  advCfg: AdvancedConfig | null,
  opts: RunOpts,
): SimResult {
  const WARMUP = 100
  const ltfSec = INTERVAL_SECONDS[cfg.timeframe] ?? 900
  const htfName = advCfg?.htfTimeframe ?? "Min60"
  const htfSec = INTERVAL_SECONDS[htfName] ?? 3600

  // F3 fix: per LTF bar, count HTF candles fully CLOSED by that bar's close time.
  const closedHtf = new Array<number>(candles.length).fill(0)
  {
    let k = 0
    for (let i = 0; i < candles.length; i++) {
      const nowSec = candles[i].time + ltfSec
      while (k < htfCandles.length && htfCandles[k].time + htfSec <= nowSec) k++
      closedHtf[i] = k
    }
  }

  const trades: Trade[] = []
  const equityCurve: number[] = []
  let closedEquity = opts.initialEquity
  let openFees = 0
  let pos: SimPosition | null = null
  let pending: PendingEntry | null = null
  let gateCandidates = 0
  let gateBlocked = 0

  const closePos = (exitBar: number, bar: Candle, exitPrice: number, reason: string) => {
    if (!pos) return
    const dir = pos.side === "long" ? 1 : -1
    const gross = (exitPrice - pos.entryPrice) * dir * pos.quantity
    const exitFee = pos.notional * opts.takerFee
    const net = gross - pos.entryFee - exitFee
    closedEquity += net
    openFees = 0
    const riskUsd = pos.initialRiskPerUnit * pos.quantity
    trades.push({
      side: pos.side, strategy: pos.strategy, reason,
      signalTime: pos.signalTime, entryTime: pos.entryTime, exitTime: bar.time,
      entryPrice: pos.entryPrice, exitPrice: exitPrice,
      quantity: pos.quantity, notional: pos.notional,
      fees: pos.entryFee + exitFee, pnl: net,
      r: riskUsd > 0 ? net / riskUsd : 0,
      maeR: pos.maeR, mfeR: pos.mfeR,
      barsHeld: exitBar - pos.entryBar, confidence: pos.confidence,
    })
    pos = null
  }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (i < WARMUP) { equityCurve.push(closedEquity); continue }
    const window = candles.slice(0, i + 1)
    const snap = computeSnapshot(window, cfg)

    // 1) Fill pending entry at THIS bar's open + slippage (F6 fix).
    if (pending && !pos) {
      const slipDir = pending.side === "long" ? 1 : -1
      const entrySlip = opts.makerEntry ? opts.slippage * 0.25 : opts.slippage
      const entryPrice = bar.open * (1 + slipDir * entrySlip)
      const stops = computeInitialStops(pending.side, entryPrice, pending.atr, cfg)
      const riskPU = Math.abs(entryPrice - stops.stopLoss)
      if (riskPU > 0) {
        const quantity = (pending.sizeUsdt * cfg.leverage) / entryPrice
        const notional = quantity * entryPrice
        const entryFee = notional * (opts.makerEntry ? opts.takerFee * 0.5 : opts.takerFee)
        openFees = entryFee
        pos = {
          side: pending.side, strategy: pending.strategy, confidence: pending.confidence,
          signalTime: pending.signalTime, signalBar: pending.signalBar,
          entryBar: i, entryTime: bar.time,
          entryPrice, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
          trailingStop: null, trailingActive: false, breakEvenMoved: false,
          highestPrice: entryPrice, lowestPrice: entryPrice, atrAtEntry: pending.atr,
          sizeUsdt: pending.sizeUsdt, leverage: cfg.leverage, quantity, notional,
          initialRiskPerUnit: riskPU, entryFee, maeR: 0, mfeR: 0,
        }
      }
      pending = null
    }

    // 2) Intra-bar exit checks (F2 fix): high/low; conservative order SL > trail > TP.
    if (pos) {
      const dir = pos.side === "long" ? 1 : -1
      const riskPU = pos.initialRiskPerUnit
      if (riskPU > 0) {
        const adverse = pos.side === "long" ? pos.entryPrice - bar.low : bar.high - pos.entryPrice
        const favorable = pos.side === "long" ? bar.high - pos.entryPrice : pos.entryPrice - bar.low
        pos.maeR = Math.min(pos.maeR, -adverse / riskPU)
        pos.mfeR = Math.max(pos.mfeR, favorable / riskPU)
      }

      const slHit = pos.side === "long" ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss
      const trail = pos.trailingActive ? pos.trailingStop : null
      const trailHit = trail != null && (pos.side === "long" ? bar.low <= trail : bar.high >= trail)
      const tpHit = !pos.trailingActive && pos.takeProfit != null &&
        (pos.side === "long" ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit)

      if (slHit) {
        const fill = pos.side === "long" ? Math.min(pos.stopLoss, bar.open) : Math.max(pos.stopLoss, bar.open)
        closePos(i, bar, fill * (1 - dir * opts.slippage), "sl")
      } else if (trailHit && trail != null) {
        const fill = pos.side === "long" ? Math.min(trail, bar.open) : Math.max(trail, bar.open)
        closePos(i, bar, fill * (1 - dir * opts.slippage), "trail")
      } else if (tpHit && pos.takeProfit != null) {
        // Resting limit order: fill at level (or better on gap), no slippage.
        const fill = pos.side === "long" ? Math.max(pos.takeProfit, bar.open) : Math.min(pos.takeProfit, bar.open)
        closePos(i, bar, fill, "tp")
      }
    }

    // 3) Close-based management (adaptive exits only; fixed mode = pure initial TP/SL).
    if (pos && opts.exits !== "fixed") {
      const opposite = opts.exits === "adaptive" ? isOppositeSignal(snap, pos.side as "long" | "short") : false
      const decision = evaluateExit(pos as any, snap, cfg, opposite)
      const u = decision.updates
      if (opts.exits === "adaptive" && u.stopLoss != null) pos.stopLoss = u.stopLoss
      if (u.trailingStop != null) pos.trailingStop = u.trailingStop
      if (u.trailingActive != null) pos.trailingActive = u.trailingActive
      if (u.breakEvenMoved != null) pos.breakEvenMoved = u.breakEvenMoved
      if (u.highestPrice != null) pos.highestPrice = u.highestPrice
      if (u.lowestPrice != null) pos.lowestPrice = u.lowestPrice
      // SL/TP/trail closes were already handled intra-bar above; only the
      // opposite-signal exit (a close-price decision) is actioned here.
      if (decision.action === "close" && decision.reason === "signal") {
        const dir = pos.side === "long" ? 1 : -1
        closePos(i, bar, bar.close * (1 - dir * opts.slippage), "signal")
      }
    }

    // 4) Mark-to-market equity every bar (F7 fix).
    const mtm = closedEquity +
      (pos ? (bar.close - pos.entryPrice) * (pos.side === "long" ? 1 : -1) * pos.quantity : 0) -
      openFees
    equityCurve.push(mtm)

    // 5) New signal — only when flat with nothing pending (F8 fix: no `continue`).
    if (!pos && !pending) {
      const signal = evaluateEntry(snap, window, cfg, STUB_MODEL, closedEquity)
      if (signal.direction) {
        let sizeUsdt = signal.dynamicSize ?? cfg.positionSizeUsdt
        let confidence = signal.confidence
        let ok = true
        if (opts.gate && advCfg) {
          gateCandidates++
          let passed = false
          const nHtf = closedHtf[i]
          if (nHtf >= 25) {
            const candlesByTf: Record<string, Candle[]> = { [cfg.timeframe]: window }
            candlesByTf[advCfg.htfTimeframe] = htfCandles.slice(0, nHtf) // F3 fix: closed only
            const adv = evaluateAdvancedEntry(
              signal.direction, confidence, signal.strategy, candlesByTf, {},
              closedEquity, snap.atr, snap.price, advCfg,
            )
            passed = adv.passed && !!adv.direction
            if (passed) {
              if (adv.sizeUsdt != null) sizeUsdt = adv.sizeUsdt
              confidence = adv.confidence
            }
          }
          if (!passed) { gateBlocked++; ok = false }
        }
        if (ok) {
          pending = {
            side: signal.direction, strategy: signal.strategy, confidence,
            sizeUsdt, atr: snap.atr, signalBar: i, signalTime: bar.time,
          }
        }
      }
    }
  }

  if (pos) {
    const lastBar = candles[candles.length - 1]
    const dir = pos.side === "long" ? 1 : -1
    closePos(candles.length - 1, lastBar, lastBar.close * (1 - dir * opts.slippage), "eod")
    equityCurve[equityCurve.length - 1] = closedEquity
  }

  return { trades, equityCurve, gateCandidates, gateBlocked }
}

// ── Metrics & reports ────────────────────────────────────────────────────────
interface Metrics {
  n: number; winRate: number; avgWin: number; avgLoss: number; expectancy: number
  profitFactor: number; totalPnl: number; sharpe: number; maxDd: number
  totalFees: number; avgR: number
}

function computeMetrics(trades: Trade[], equityCurve: number[]): Metrics | null {
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
  const totalFees = trades.reduce((s, t) => s + t.fees, 0)
  const avgR = trades.reduce((s, t) => s + t.r, 0) / n

  const pnls = trades.map((t) => t.pnl)
  const mean = totalPnl / n
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? mean / std : 0

  let peak = -Infinity
  let maxDd = 0
  for (const e of equityCurve) {
    peak = Math.max(peak, e)
    maxDd = Math.max(maxDd, peak > 0 ? (peak - e) / peak : 0)
  }
  return { n, winRate, avgWin, avgLoss, expectancy, profitFactor, totalPnl, sharpe, maxDd, totalFees, avgR }
}

function groupBreakdown(trades: Trade[], key: (t: Trade) => string): { name: string; n: number; winRate: number; totalPnl: number; avgR: number }[] {
  const by = new Map<string, Trade[]>()
  for (const t of trades) {
    const k = key(t)
    const arr = by.get(k) ?? []
    arr.push(t)
    by.set(k, arr)
  }
  return [...by.entries()].map(([name, ts]) => {
    const wins = ts.filter((t) => t.pnl > 0).length
    return {
      name, n: ts.length,
      winRate: ts.length ? wins / ts.length : 0,
      totalPnl: ts.reduce((s, t) => s + t.pnl, 0),
      avgR: ts.reduce((s, t) => s + t.r, 0) / ts.length,
    }
  })
}

function printReport(title: string, res: SimResult, initialEquity: number) {
  const m = computeMetrics(res.trades, res.equityCurve)
  console.log(`\n${"═".repeat(54)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(54)}`)
  if (!m) { console.log("  No trades generated."); return }
  console.log(`  Trades:            ${m.n}`)
  console.log(`  Win rate:          ${(m.winRate * 100).toFixed(1)}%`)
  console.log(`  Avg win:           ${m.avgWin.toFixed(2)} USDT`)
  console.log(`  Avg loss:          ${m.avgLoss.toFixed(2)} USDT`)
  console.log(`  Expectancy:        ${m.expectancy.toFixed(2)} USDT/trade`)
  console.log(`  Avg R:             ${m.avgR.toFixed(3)}R`)
  console.log(`  Profit factor:     ${m.profitFactor === Infinity ? "inf" : m.profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:         ${m.totalPnl.toFixed(2)} USDT (${((m.totalPnl / initialEquity) * 100).toFixed(1)}%)`)
  console.log(`  Total fees:        ${m.totalFees.toFixed(2)} USDT`)
  console.log(`  Sharpe (per-trade):${m.sharpe.toFixed(3)}`)
  console.log(`  Max drawdown (MTM):${(m.maxDd * 100).toFixed(1)}%`)
  if (res.gateCandidates > 0) {
    const passRate = ((res.gateCandidates - res.gateBlocked) / res.gateCandidates) * 100
    console.log(`  Gate:              ${res.gateCandidates - res.gateBlocked}/${res.gateCandidates} passed (${passRate.toFixed(1)}%)`)
  }
  console.log(`\n  Per-strategy:`)
  for (const s of groupBreakdown(res.trades, (t) => t.strategy)) {
    console.log(`    ${s.name.padEnd(8)} n=${String(s.n).padEnd(5)} win=${(s.winRate * 100).toFixed(1)}%  pnl=${s.totalPnl.toFixed(2)}  avgR=${s.avgR.toFixed(2)}`)
  }
  console.log(`  Per-exit-reason:`)
  for (const s of groupBreakdown(res.trades, (t) => t.reason)) {
    console.log(`    ${s.name.padEnd(8)} n=${String(s.n).padEnd(5)} win=${(s.winRate * 100).toFixed(1)}%  pnl=${s.totalPnl.toFixed(2)}`)
  }
}

function printComparison(title: string, runs: { label: string; res: SimResult }[], initialEquity: number) {
  const ms = runs.map((r) => computeMetrics(r.res.trades, r.res.equityCurve))
  console.log(`\n${"═".repeat(54)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(54)}`)
  const w = 14
  console.log(`  ${"".padEnd(16)}${runs.map((r) => r.label.slice(0, w).padEnd(w)).join("")}`)
  const row = (label: string, f: (m: Metrics) => string) => {
    console.log(`  ${label.padEnd(16)}${ms.map((m) => (m ? f(m) : "-").padEnd(w)).join("")}`)
  }
  row("Trades", (m) => String(m.n))
  row("Win rate", (m) => `${(m.winRate * 100).toFixed(1)}%`)
  row("Expectancy", (m) => m.expectancy.toFixed(2))
  row("Avg R", (m) => m.avgR.toFixed(3))
  row("Profit factor", (m) => m.profitFactor === Infinity ? "inf" : m.profitFactor.toFixed(2))
  row("Total PnL", (m) => `${m.totalPnl.toFixed(0)} (${((m.totalPnl / initialEquity) * 100).toFixed(1)}%)`)
  row("Max DD", (m) => `${(m.maxDd * 100).toFixed(1)}%`)
  row("Fees", (m) => m.totalFees.toFixed(0))
}

function dumpCsv(basePath: string, label: string, trades: Trade[]) {
  const path = basePath.replace(/\.csv$/, "") + "_" + label.replace(/[^a-z0-9]+/gi, "-") + ".csv"
  const header = "side,strategy,reason,signalTime,entryTime,exitTime,entryPrice,exitPrice,quantity,notional,fees,pnl,r,maeR,mfeR,barsHeld,confidence"
  const lines = trades.map((t) => [
    t.side, t.strategy, t.reason,
    new Date(t.signalTime * 1000).toISOString(),
    new Date(t.entryTime * 1000).toISOString(),
    new Date(t.exitTime * 1000).toISOString(),
    t.entryPrice, t.exitPrice, t.quantity, t.notional, t.fees.toFixed(4),
    t.pnl.toFixed(4), t.r.toFixed(4), t.maeR.toFixed(4), t.mfeR.toFixed(4),
    t.barsHeld, t.confidence.toFixed(4),
  ].join(","))
  fs.writeFileSync(path, [header, ...lines].join("\n"))
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2))
  const endSec = Math.floor(Date.now() / 1000) - a.offsetDays * 86400
  const startSec = endSec - a.days * 86400

  console.log(`Fetching ${a.symbol} ${a.timeframe} for ${a.days} days...`)
  const candles = await fetchKlinesRange(a.symbol, a.timeframe, startSec, endSec)
  console.log(`Fetched ${candles.length} candles`)

  const cfg = buildConfig(a)
  const advCfg: AdvancedConfig = {
    ...DEFAULT_ADVANCED_CONFIG,
    enabled: true,
    htfTimeframe: a.htf,
    smartMoneyEnabled: false, // not backtestable — real-time only
  }

  let htfCandles: Candle[] = []
  if (a.gate || a.compare || a.matrix) {
    htfCandles = await fetchKlinesRange(a.symbol, a.htf, startSec, endSec)
    console.log(`Fetched ${htfCandles.length} HTF (${a.htf}) candles`)
  }

  const base = { takerFee: a.fees, slippage: a.slippage, initialEquity: a.equity, makerEntry: a.makerEntry }
  let runs: { label: string; gate: boolean; exits: "adaptive" | "fixed" | "trailonly" }[]
  if (a.matrix) {
    runs = [
      { label: "base+adaptive", gate: false, exits: "adaptive" },
      { label: "gate+adaptive", gate: true, exits: "adaptive" },
      { label: "base+fixed", gate: false, exits: "fixed" },
      { label: "gate+fixed", gate: true, exits: "fixed" },
    ]
  } else if (a.compare) {
    runs = [
      { label: "base+adaptive", gate: false, exits: "adaptive" },
      { label: "gate+adaptive", gate: true, exits: "adaptive" },
    ]
  } else {
    runs = [{ label: `${a.gate ? "gate" : "base"}+${a.exits}${a.strategy !== "auto" ? "+" + a.strategy : ""}${a.makerEntry ? "+mk" : ""}`, gate: a.gate, exits: a.exits }]
  }

  const results: { label: string; res: SimResult }[] = []
  for (const r of runs) {
    const res = simulate(candles, htfCandles, cfg, advCfg, { ...base, gate: r.gate, exits: r.exits })
    results.push({ label: r.label, res })
    printReport(`${r.label.toUpperCase()}  [${a.symbol} ${a.timeframe} ${a.days}d]`, res, a.equity)
    if (a.dump) dumpCsv(a.dump, r.label, res.trades)
  }
  if (results.length > 1) printComparison(`COMPARISON [${a.symbol}]`, results, a.equity)
  if (a.dump) console.log(`\nPer-trade CSVs: ${a.dump.replace(/\.csv$/, "")}_*.csv`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})

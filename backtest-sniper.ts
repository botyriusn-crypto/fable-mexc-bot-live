// backtest-sniper.ts — v2: replay the REAL sniper detector (lib/sniper.ts
// detectSniper) over history with honest execution.
//
// Execution model:
//   - Signal on rolling 200-candle window (live parity).
//   - Entry at NEXT bar open + slippage (--entry close for signal-close fills).
//   - SL/TP are the structural signal levels; TP overridable via --tp-ratio.
//   - SL/TP checked INTRA-BAR (high/low); same-bar both-touched => STOP wins.
//     Gap-aware fills. Taker fee both sides, slippage on market fills.
//   - --be-at R: once favorable excursion touches R x initial risk, stop moves
//     to entry, effective NEXT bar (same-bar path after touch is unknowable).
//     Exits on that stop are tagged "be".
//   - --min-stop-pct p: skip signals whose stop distance < p% of price
//     (sub-noise stops -> wick-outs + oversized notional per unit risk).
//   - --offset-days d: shift window d days back (pseudo out-of-sample).
//   - Sizing: risk --risk-pct of equity to the structural stop; notional capped
//     at equity x leverage. Funding not modeled.
//
// Usage:
//   npx tsx backtest-sniper.ts --symbol WLD_USDT --timeframe Min5 --days 60
//   npx tsx backtest-sniper.ts --symbol WLD_USDT --days 60 --be-at 1.0
//   npx tsx backtest-sniper.ts --symbol WLD_USDT --days 60 --be-at 1.0 --offset-days 60

import * as fs from "node:fs"
import { detectSniper } from "./lib/sniper"
import type { IndicatorSnapshot } from "./lib/indicators"
import type { Candle } from "./lib/mexc/public"

// ── CLI ──────────────────────────────────────────────────────────────────────
interface CliArgs {
  symbol: string
  timeframe: string
  days: number
  leverage: number
  riskPct: number
  fees: number
  slippage: number
  equity: number
  entryMode: "next-open" | "close"
  sigma: number
  volMult: number
  maxBars: number
  beAt: number
  tpRatio: number
  minStopPct: number
  offsetDays: number
  dump: string | null
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    symbol: "BTC_USDT", timeframe: "Min5", days: 60, leverage: 3, riskPct: 0.01,
    fees: 0.0002, slippage: 0.0003, equity: 10000, entryMode: "next-open",
    sigma: 3.5, volMult: 2.0, maxBars: 0, beAt: 0, tpRatio: 0, minStopPct: 0,
    offsetDays: 0, dump: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    switch (k) {
      case "--symbol": a.symbol = v; i++; break
      case "--timeframe": a.timeframe = v; i++; break
      case "--days": a.days = Number(v); i++; break
      case "--leverage": a.leverage = Number(v); i++; break
      case "--risk-pct": a.riskPct = Number(v); i++; break
      case "--fees": a.fees = Number(v); i++; break
      case "--slippage": a.slippage = Number(v); i++; break
      case "--equity": a.equity = Number(v); i++; break
      case "--entry": a.entryMode = v === "close" ? "close" : "next-open"; i++; break
      case "--sigma": a.sigma = Number(v); i++; break
      case "--vol-mult": a.volMult = Number(v); i++; break
      case "--max-bars": a.maxBars = Number(v); i++; break
      case "--be-at": a.beAt = Number(v); i++; break
      case "--tp-ratio": a.tpRatio = Number(v); i++; break
      case "--min-stop-pct": a.minStopPct = Number(v); i++; break
      case "--offset-days": a.offsetDays = Number(v); i++; break
      case "--dump": a.dump = v; i++; break
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

// ── Simulation ───────────────────────────────────────────────────────────────
const LOOKBACK = 200 // live parity: runSniperCycle fetches 200 klines

interface SnPos {
  side: "long" | "short"
  signalType: "sweep" | "sigma" | null
  signalReason: string
  confidence: number
  signalTime: number
  signalBar: number
  entryBar: number
  entryTime: number
  entryPrice: number
  stopLoss: number
  takeProfit: number
  quantity: number
  notional: number
  entryFee: number
  maeR: number
  mfeR: number
  riskPU: number   // |entry - initial stop|, frozen at entry (R denominator)
  stopPct: number  // stop distance as % of entry price
  beMoved: boolean
}

interface SnTrade {
  side: "long" | "short"
  signalType: string
  reason: string
  signalTime: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  quantity: number
  notional: number
  stopPct: number
  fees: number
  pnl: number
  r: number
  maeR: number
  mfeR: number
  barsHeld: number
  confidence: number
}

interface SnPending {
  side: "long" | "short"
  signalType: "sweep" | "sigma" | null
  reason: string
  confidence: number
  stopLoss: number
  takeProfit: number
  signalBar: number
  signalTime: number
}

function simulate(a: CliArgs, candles: Candle[]): { trades: SnTrade[]; equityCurve: number[]; skippedMinStop: number } {
  const trades: SnTrade[] = []
  const equityCurve: number[] = []
  let closedEquity = a.equity
  let openFees = 0
  let pos: SnPos | null = null
  let pending: SnPending | null = null
  let skippedMinStop = 0

  const closePos = (exitBar: number, bar: Candle, exitPrice: number, reason: string) => {
    if (!pos) return
    const dir = pos.side === "long" ? 1 : -1
    const gross = (exitPrice - pos.entryPrice) * dir * pos.quantity
    const exitFee = pos.notional * a.fees
    const net = gross - pos.entryFee - exitFee
    closedEquity += net
    openFees = 0
    const riskUsd = pos.riskPU * pos.quantity
    trades.push({
      side: pos.side, signalType: pos.signalType ?? "?", reason,
      signalTime: pos.signalTime, entryTime: pos.entryTime, exitTime: bar.time,
      entryPrice: pos.entryPrice, exitPrice: exitPrice,
      quantity: pos.quantity, notional: pos.notional, stopPct: pos.stopPct,
      fees: pos.entryFee + exitFee, pnl: net,
      r: riskUsd > 0 ? net / riskUsd : 0,
      maeR: pos.maeR, mfeR: pos.mfeR,
      barsHeld: exitBar - pos.entryBar, confidence: pos.confidence,
    })
    pos = null
  }

  const openPos = (
    i: number, bar: Candle, side: "long" | "short", entryPrice: number,
    sig: { signalType: "sweep" | "sigma" | null; reason: string; confidence: number; stopLoss: number; takeProfit: number },
    signalTime: number,
  ): void => {
    const riskPU = Math.abs(entryPrice - sig.stopLoss)
    if (riskPU <= 0) return
    const stopPct = (riskPU / entryPrice) * 100
    if (a.minStopPct > 0 && stopPct < a.minStopPct) { skippedMinStop++; return }
    let takeProfit = sig.takeProfit
    if (a.tpRatio > 0) {
      takeProfit = side === "long" ? entryPrice + riskPU * a.tpRatio : entryPrice - riskPU * a.tpRatio
    }
    let quantity = (closedEquity * a.riskPct) / riskPU
    const maxNotional = closedEquity * a.leverage
    if (quantity * entryPrice > maxNotional) quantity = maxNotional / entryPrice
    const notional = quantity * entryPrice
    const entryFee = notional * a.fees
    openFees = entryFee
    pos = {
      side, signalType: sig.signalType, signalReason: sig.reason,
      confidence: sig.confidence, signalTime, signalBar: i,
      entryBar: i, entryTime: bar.time, entryPrice,
      stopLoss: sig.stopLoss, takeProfit,
      quantity, notional, entryFee, maeR: 0, mfeR: 0,
      riskPU, stopPct, beMoved: false,
    }
  }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (i < 60) { equityCurve.push(closedEquity); continue }

    // 1) Fill pending entry at this bar's open + slippage.
    if (pending && !pos) {
      const slipDir = pending.side === "long" ? 1 : -1
      const entryPrice = bar.open * (1 + slipDir * a.slippage)
      const p = pending
      pending = null
      openPos(i, bar, p.side, entryPrice, p, p.signalTime)
    }

    // 2) Intra-bar SL/TP (SL first), gap-aware; time stop; BE move.
    if (pos) {
      const dir = pos.side === "long" ? 1 : -1
      const adverse = pos.side === "long" ? pos.entryPrice - bar.low : bar.high - pos.entryPrice
      const favorable = pos.side === "long" ? bar.high - pos.entryPrice : pos.entryPrice - bar.low
      pos.maeR = Math.min(pos.maeR, -adverse / pos.riskPU)
      pos.mfeR = Math.max(pos.mfeR, favorable / pos.riskPU)

      const slHit = pos.side === "long" ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss
      const tpHit = pos.side === "long" ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit
      if (slHit) {
        const fill = pos.side === "long" ? Math.min(pos.stopLoss, bar.open) : Math.max(pos.stopLoss, bar.open)
        closePos(i, bar, fill * (1 - dir * a.slippage), pos.beMoved ? "be" : "sl")
      } else if (tpHit) {
        const fill = pos.side === "long" ? Math.max(pos.takeProfit, bar.open) : Math.min(pos.takeProfit, bar.open)
        closePos(i, bar, fill, "tp")
      } else if (a.maxBars > 0 && i - pos.entryBar >= a.maxBars) {
        closePos(i, bar, bar.close * (1 - dir * a.slippage), "time")
      } else if (a.beAt > 0 && !pos.beMoved) {
        // Trigger on intra-bar touch; the new stop (entry) is active NEXT bar.
        if (favorable >= pos.riskPU * a.beAt) {
          pos.stopLoss = pos.entryPrice
          pos.beMoved = true
        }
      }
    }

    // 3) MTM equity.
    const mtm = closedEquity +
      (pos ? (bar.close - pos.entryPrice) * (pos.side === "long" ? 1 : -1) * pos.quantity : 0) -
      openFees
    equityCurve.push(mtm)

    // 4) New signal (rolling 200-candle window = live parity).
    if (!pos && !pending) {
      const window = candles.slice(Math.max(0, i + 1 - LOOKBACK), i + 1)
      const sig = detectSniper(window, {} as IndicatorSnapshot, 0, {
        sigmaExtreme: a.sigma,
        volumeSurgeMult: a.volMult,
      })
      if (sig.direction && sig.stopLoss > 0 && sig.takeProfit > 0) {
        if (a.entryMode === "close") {
          const slipDir = sig.direction === "long" ? 1 : -1
          const entryPrice = bar.close * (1 + slipDir * a.slippage)
          openPos(i, bar, sig.direction, entryPrice, sig, bar.time)
        } else {
          pending = {
            side: sig.direction, signalType: sig.signalType, reason: sig.reason,
            confidence: sig.confidence, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit,
            signalBar: i, signalTime: bar.time,
          }
        }
      }
    }
  }

  if (pos) {
    const lastBar = candles[candles.length - 1]
    const dir = pos.side === "long" ? 1 : -1
    closePos(candles.length - 1, lastBar, lastBar.close * (1 - dir * a.slippage), "eod")
    equityCurve[equityCurve.length - 1] = closedEquity
  }

  return { trades, equityCurve, skippedMinStop }
}

// ── Metrics & report ─────────────────────────────────────────────────────────
function metrics(trades: SnTrade[], curve: number[]) {
  const n = trades.length
  if (n === 0) return null
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const winRate = wins.length / n
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const totalPnl = grossProfit - grossLoss
  const pnls = trades.map((t) => t.pnl)
  const mean = totalPnl / n
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n)
  let peak = -Infinity
  let maxDd = 0
  for (const e of curve) { peak = Math.max(peak, e); maxDd = Math.max(maxDd, peak > 0 ? (peak - e) / peak : 0) }
  return {
    n, winRate,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    expectancy: totalPnl / n,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    totalPnl, totalFees: trades.reduce((s, t) => s + t.fees, 0),
    avgR: trades.reduce((s, t) => s + t.r, 0) / n,
    sharpe: std > 0 ? mean / std : 0, maxDd,
  }
}

function breakdown(trades: SnTrade[], key: (t: SnTrade) => string) {
  const by = new Map<string, SnTrade[]>()
  for (const t of trades) {
    const arr = by.get(key(t)) ?? []
    arr.push(t)
    by.set(key(t), arr)
  }
  return [...by.entries()].map(([name, ts]) => ({
    name, n: ts.length,
    winRate: ts.filter((t) => t.pnl > 0).length / ts.length,
    totalPnl: ts.reduce((s, t) => s + t.pnl, 0),
    avgR: ts.reduce((s, t) => s + t.r, 0) / ts.length,
  }))
}

function report(a: CliArgs, trades: SnTrade[], curve: number[], skipped: number) {
  const m = metrics(trades, curve)
  const extras: string[] = []
  if (a.beAt > 0) extras.push(`beAt=${a.beAt}R`)
  if (a.tpRatio > 0) extras.push(`tpRatio=${a.tpRatio}`)
  if (a.minStopPct > 0) extras.push(`minStop=${a.minStopPct}%`)
  if (a.offsetDays > 0) extras.push(`offset=${a.offsetDays}d`)
  console.log(`\n${"═".repeat(54)}`)
  console.log(`  SNIPER BACKTEST  [${a.symbol} ${a.timeframe} ${a.days}d]`)
  console.log(`  entry=${a.entryMode}  sigma=${a.sigma}  volMult=${a.volMult}  lev=${a.leverage}x  risk=${(a.riskPct * 100).toFixed(1)}%  fees=${(a.fees * 100).toFixed(3)}%  slip=${(a.slippage * 100).toFixed(3)}%${a.maxBars > 0 ? `  maxBars=${a.maxBars}` : ""}${extras.length ? "  " + extras.join("  ") : ""}`)
  console.log(`${"═".repeat(54)}`)
  if (!m) {
    console.log("  No trades generated.")
    console.log("  -> Widen --days, or relax --sigma / --vol-mult (e.g. --sigma 3.0 --vol-mult 1.5).")
    return
  }
  console.log(`  Trades:            ${m.n}`)
  console.log(`  Win rate:          ${(m.winRate * 100).toFixed(1)}%  (breakeven at 3:1 after costs is ~26-28%)`)
  console.log(`  Avg win:           ${m.avgWin.toFixed(2)} USDT`)
  console.log(`  Avg loss:          ${m.avgLoss.toFixed(2)} USDT`)
  console.log(`  Expectancy:        ${m.expectancy.toFixed(2)} USDT/trade`)
  console.log(`  Avg R:             ${m.avgR.toFixed(3)}R`)
  console.log(`  Profit factor:     ${m.profitFactor === Infinity ? "inf" : m.profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:         ${m.totalPnl.toFixed(2)} USDT (${((m.totalPnl / a.equity) * 100).toFixed(1)}%)`)
  console.log(`  Total fees:        ${m.totalFees.toFixed(2)} USDT`)
  console.log(`  Sharpe (per-trade):${m.sharpe.toFixed(3)}`)
  console.log(`  Max drawdown (MTM):${(m.maxDd * 100).toFixed(1)}%`)
  if (a.minStopPct > 0) console.log(`  Skipped (stop<${a.minStopPct}%): ${skipped}`)
  for (const [title, key] of [
    ["By signal type", (t: SnTrade) => t.signalType] as const,
    ["By direction", (t: SnTrade) => t.side] as const,
    ["By exit reason", (t: SnTrade) => t.reason] as const,
  ]) {
    console.log(`\n  ${title}:`)
    for (const s of breakdown(trades, key)) {
      console.log(`    ${s.name.padEnd(8)} n=${String(s.n).padStart(4)}  win=${(s.winRate * 100).toFixed(1)}%  pnl=${s.totalPnl.toFixed(2)}  avgR=${s.avgR.toFixed(2)}`)
    }
  }
  // Stop-distance diagnostics: are sub-noise stops the ones dying?
  const stopBuckets: [string, (p: number) => boolean][] = [
    ["<0.3%", (p) => p < 0.3], ["0.3-0.6%", (p) => p >= 0.3 && p < 0.6],
    ["0.6-1.0%", (p) => p >= 0.6 && p < 1.0], [">=1.0%", (p) => p >= 1.0],
  ]
  console.log(`\n  Stop-distance buckets (stop as % of entry):`)
  for (const [name, test] of stopBuckets) {
    const ts = trades.filter((t) => test(t.stopPct))
    if (!ts.length) continue
    const wr = ts.filter((t) => t.pnl > 0).length / ts.length
    const ar = ts.reduce((s, t) => s + t.r, 0) / ts.length
    console.log(`    ${name.padEnd(9)} n=${String(ts.length).padStart(4)}  win=${(wr * 100).toFixed(1)}%  avgR=${ar.toFixed(2)}`)
  }
  // MFE reached before full-SL death: how much upside did the losers touch?
  const slLosers = trades.filter((t) => t.reason === "sl")
  if (slLosers.length > 0) {
    console.log(`\n  MFE before full-SL death (of ${slLosers.length} SL losers):`)
    for (const th of [1, 1.5, 2, 2.5]) {
      const c = slLosers.filter((t) => t.mfeR >= th).length
      console.log(`    >=+${th}R: ${String(c).padStart(4)} (${((c / slLosers.length) * 100).toFixed(0)}%)  <- a TP at ${th}R converts these`)
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2))
  const endSec = Math.floor(Date.now() / 1000) - a.offsetDays * 86400
  const startSec = endSec - a.days * 86400
  console.log(`Fetching ${a.symbol} ${a.timeframe} for ${a.days} days (offset ${a.offsetDays}d)...`)
  const candles = await fetchKlinesRange(a.symbol, a.timeframe, startSec, endSec)
  console.log(`Fetched ${candles.length} candles`)
  const { trades, equityCurve, skippedMinStop } = simulate(a, candles)
  report(a, trades, equityCurve, skippedMinStop)
  if (a.dump) {
    const header = "side,signalType,reason,signalTime,entryTime,exitTime,entryPrice,exitPrice,quantity,notional,stopPct,fees,pnl,r,maeR,mfeR,barsHeld,confidence"
    const lines = trades.map((t) => [
      t.side, t.signalType, t.reason,
      new Date(t.signalTime * 1000).toISOString(),
      new Date(t.entryTime * 1000).toISOString(),
      new Date(t.exitTime * 1000).toISOString(),
      t.entryPrice, t.exitPrice, t.quantity, t.notional, t.stopPct.toFixed(4),
      t.fees.toFixed(4), t.pnl.toFixed(4), t.r.toFixed(4), t.maeR.toFixed(4), t.mfeR.toFixed(4),
      t.barsHeld, t.confidence.toFixed(4),
    ].join(","))
    fs.writeFileSync(a.dump, [header, ...lines].join("\n"))
    console.log(`\nPer-trade CSV: ${a.dump}`)
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})

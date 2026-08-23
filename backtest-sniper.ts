// backtest-sniper.ts — replay historical klines through detectSniper and
// simulate the real SL/TP walk-forward outcome, to A/B test the asymmetries.
//
// Usage:
//   tsx backtest-sniper.ts --symbols BTC_USDT,ETH_USDT,SOL_USDT --timeframe Min5 --days 60 --compare
//
// Honest limitations:
//   - fundingRate is stubbed to 0 (no historical funding source on MEXC public API).
//   - Uses a fixed 200-candle window per signal (matches runSniperCycle).

import { detectSniper, type SniperOverrides } from "./lib/sniper"
import type { Candle } from "./lib/mexc/public"

interface CliArgs { symbols: string[]; timeframe: string; days: number; compare: boolean }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { symbols: ["BTC_USDT"], timeframe: "Min5", days: 60, compare: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === "--symbols") a.symbols = argv[++i].split(",").map(s => s.trim())
    else if (v === "--symbol") a.symbols = [argv[++i]]
    else if (v === "--timeframe") a.timeframe = argv[++i]
    else if (v === "--days") a.days = parseInt(argv[++i], 10)
    else if (v === "--compare") a.compare = true
  }
  return a
}

function intervalToSeconds(interval: string): number {
  const m = /Min(\d+)/.exec(interval)
  if (m) return parseInt(m[1], 10) * 60
  const h = /Hour(\d+)/.exec(interval)
  if (h) return parseInt(h[1], 10) * 3600
  return 300
}

// Fetch a full date range by paginating backward in 1000-candle batches.
// MEXC returns candles oldest-first; we track the oldest time seen and request
// older data until we reach `start` or the API returns a short batch.
async function fetchKlinesRange(symbol: string, interval: string, days: number): Promise<Candle[]> {
  const intervalSec = intervalToSeconds(interval)
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const BATCH = 1000
  const all: Candle[] = []
  let batchEnd = end
  while (batchEnd > start) {
    const batchStart = batchEnd - BATCH * intervalSec
    const url = `https://api.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&start=${batchStart}&end=${batchEnd}`
    const res = await fetch(url, { cache: "no-store" })
    const json = await res.json() as any
    if (!json.success || !json.data || !json.data.time?.length) break
    const { time, open, high, low, close, vol } = json.data
    for (let i = 0; i < time.length; i++) {
      all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] })
    }
    const oldest = Math.min(...time)
    // Stop only when we've reached the overall target start date, or the API
    // returned a short batch (no more history available). Stepping back one
    // interval avoids re-fetching the boundary candle.
    if (oldest <= start) break
    if (time.length < BATCH) break
    batchEnd = oldest - intervalSec
  }
  const seen = new Set<number>()
  const deduped = all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true })
  deduped.sort((a, b) => a.time - b.time)
  return deduped
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
  }
  return sum / period
}

interface Trade {
  direction: "long" | "short"
  signalType: "sweep" | "sigma"
  outcome: "tp" | "sl"
  rMultiple: number
}

function simulate(candles: Candle[], overrides: SniperOverrides): Trade[] {
  const trades: Trade[] = []
  const WINDOW = 200
  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(i - WINDOW, i + 1)
    const snap = { atr: atr(window), price: window[window.length - 1].close } as any
    const sig = detectSniper(window, snap, 0, overrides)
    if (!sig.direction || !sig.signalType) continue

    const entry = window[window.length - 1].close
    const isLong = sig.direction === "long"
    let outcome: "tp" | "sl" | "open" = "open"
    let exitPrice = entry

    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j]
      if (isLong) {
        if (c.low <= sig.stopLoss) { outcome = "sl"; exitPrice = sig.stopLoss; break }
        if (c.high >= sig.takeProfit) { outcome = "tp"; exitPrice = sig.takeProfit; break }
      } else {
        if (c.high >= sig.stopLoss) { outcome = "sl"; exitPrice = sig.stopLoss; break }
        if (c.low <= sig.takeProfit) { outcome = "tp"; exitPrice = sig.takeProfit; break }
      }
    }
    if (outcome === "open") continue

    const risk = Math.abs(entry - sig.stopLoss)
    const rMultiple = risk > 0 ? ((exitPrice - entry) / risk) * (isLong ? 1 : -1) : 0
    trades.push({ direction: sig.direction, signalType: sig.signalType, outcome, rMultiple })
  }
  return trades
}

function report(name: string, trades: Trade[]) {
  const n = trades.length
  const wins = trades.filter(t => t.outcome === "tp")
  const losses = trades.filter(t => t.outcome === "sl")
  const winRate = n ? wins.length / n : 0
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0)
  const expectancy = n ? totalR / n : 0
  const grossWin = wins.reduce((s, t) => s + t.rMultiple, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0))
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)

  const byType = (type: "sweep" | "sigma") => {
    const ts = trades.filter(t => t.signalType === type)
    const w = ts.filter(t => t.outcome === "tp").length
    return `${type}=n${ts.length}/win${ts.length ? (w / ts.length * 100).toFixed(0) : 0}%`
  }
  const byDir = (dir: "long" | "short") => {
    const ts = trades.filter(t => t.direction === dir)
    const w = ts.filter(t => t.outcome === "tp").length
    return `${dir}=n${ts.length}/win${ts.length ? (w / ts.length * 100).toFixed(0) : 0}%`
  }

  console.log(`\n  ${name}`)
  console.log(`    Trades=${n}  Win=${(winRate * 100).toFixed(1)}%  Expectancy=${expectancy.toFixed(3)}R  Total=${totalR.toFixed(1)}R  PF=${pf === Infinity ? "inf" : pf.toFixed(2)}`)
  console.log(`    ${byType("sweep")}  ${byType("sigma")}`)
  console.log(`    ${byDir("long")}  ${byDir("short")}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`Symbols: ${args.symbols.join(", ")} | ${args.timeframe} | ${args.days} days`)

  // Fetch all symbols first so we can report per-symbol candle counts.
  const data: Array<{ symbol: string; candles: Candle[] }> = []
  for (const sym of args.symbols) {
    const candles = await fetchKlinesRange(sym, args.timeframe, args.days)
    console.log(`  ${sym}: ${candles.length} candles`)
    data.push({ symbol: sym, candles })
  }

  const variants: Array<[string, SniperOverrides, "all" | "long" | "short"]> = args.compare
    ? [
        ["BASELINE (current production)", {}, "all"],
        ["LONG-ONLY", {}, "long"],
        ["SHORT-ONLY", {}, "short"],
        ["LONG-ONLY + sigma2", { tpSlRatioSigma: 2 }, "long"],
        ["LONG-ONLY + shortPct + sigma2", { shortStopBufferPct: true, tpSlRatioSigma: 2 }, "long"],
      ]
    : [["BASELINE", {}, "all"]]

  for (const [name, ov, side] of variants) {
    const all: Trade[] = []
    for (const { candles } of data) {
      let trades = simulate(candles, ov)
      if (side === "long") trades = trades.filter(t => t.direction === "long")
      if (side === "short") trades = trades.filter(t => t.direction === "short")
      all.push(...trades)
    }
    report(name, all)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

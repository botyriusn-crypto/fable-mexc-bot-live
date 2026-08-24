// backtest-trend-rider.ts — replay historical klines through the new
// Trend Rider strategy (lib/trend-rider.ts) and report the same metrics
// format as backtest-advanced.ts, so results are directly comparable.
//
// Usage:
//   tsx backtest-trend-rider.ts --symbol WLD_USDT --timeframe Min15 --days 10
//   tsx backtest-trend-rider.ts --symbol WLD_USDT --timeframe Min15 --days 10 --leverage 3

import { evaluateTrendRider, detectTrendState, DEFAULT_TREND_RIDER_CONFIG, type TrendRiderPosition, type TrendRiderConfig } from "./lib/trend-rider"
import { atr } from "./lib/indicators"
import type { Candle } from "./lib/mexc/public"

// ── CLI ──────────────────────────────────────────────────────────────────────
interface CliArgs {
  symbol: string
  timeframe: string
  days: number
  htf: string
  signalTf: string
  entryTf: string
  leverage: number
  feePct: number
  slipPct: number
  minStrength: number
  chandelierMult: number
  breakevenAtr: number
  pullbackAtr: number
  noRejection: boolean
  minTrendAge: number
  htfSwing: boolean
  regimeTf: string
  adxFloor: number
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    symbol: "BTC_USDT",
    timeframe: "Min15",
    days: 10,
    htf: "Min60",
    signalTf: "Min240",
    entryTf: "Min15",
    leverage: 3,
    feePct: 0.0002,
    slipPct: 0.0003,
    minStrength: 0.75,
    chandelierMult: 3.0,
    breakevenAtr: 1.0,
    pullbackAtr: 0.3,
    noRejection: false,
    minTrendAge: 3,
    htfSwing: true,
    regimeTf: "Day1",
    adxFloor: 22,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    switch (k) {
      case "--symbol": a.symbol = v; i++; break
      case "--timeframe": a.timeframe = v; a.entryTf = v; i++; break
      case "--days": a.days = Number(v); i++; break
      case "--htf": a.htf = v; a.signalTf = v; i++; break
      case "--signal-tf": a.signalTf = v; i++; break
      case "--entry-tf": a.entryTf = v; i++; break
      case "--leverage": a.leverage = Number(v); i++; break
      case "--fee": a.feePct = Number(v); i++; break
      case "--slip": a.slipPct = Number(v); i++; break
      case "--min-strength": a.minStrength = Number(v); i++; break
      case "--adx-floor": a.adxFloor = Number(v); i++; break
      case "--chandelier-mult": a.chandelierMult = Number(v); i++; break
      case "--breakeven-atr": a.breakevenAtr = Number(v); i++; break
      case "--signal-tf": a.signalTf = v; i++; break
      case "--entry-tf": a.entryTf = v; i++; break
      case "--timeframe": a.entryTf = v; i++; break  // alias for backward compat
      case "--pullback-atr": a.pullbackAtr = Number(v); i++; break
      case "--no-rejection": a.noRejection = true; break
      case "--min-trend-age": a.minTrendAge = Number(v); i++; break
      case "--htf-swing": a.htfSwing = v === "true"; i++; break
      case "--regime-tf": a.regimeTf = v; i++; break
    }
  }
  return a
}

// ── Data fetch (mirrors backtest-advanced.ts) ────────────────────────────────
const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60, Min3: 180, Min5: 300, Min15: 900, Min30: 1800,
  Min60: 3600, Min120: 7200, Min240: 14400, Min480: 28800, Min720: 43200, Min1440: 86400,
  Hour1: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400,
}

// MEXC API uses different interval names than our internal identifiers
const INTERVAL_TO_MEXC: Record<string, string> = {
  Min1: "Min1",
  Min5: "Min5",
  Min15: "Min15",
  Min30: "Min30",
  Min60: "Min60",
  Min240: "Hour4",
  Min480: "Hour8",
  Min1440: "Day1",
  Hour1: "Min60",
  Hour4: "Hour4",
  Hour8: "Hour8",
  Day1: "Day1",
}
const BASE_URL = "https://api.mexc.com/api/v1/contract"


// Map timeframe aliases to MEXC API format
// MEXC uses Min-based naming: Min240 = 4 hours, Min1440 = 1 day
function normalizeInterval(tf: string): string {
  // MEXC accepts Min240, Min1440 etc. directly - no normalization needed
  return tf
}

async function fetchKlinesRange(symbol: string, interval: string, startSec: number, endSec: number): Promise<Candle[]> {
  const seconds = INTERVAL_SECONDS[interval]
  if (!seconds) throw new Error(`Unknown interval: ${interval}`)
  const mexcInterval = INTERVAL_TO_MEXC[interval] || interval
  const CHUNK = 1000
  const out: Candle[] = []
  let cursor = startSec
  while (cursor < endSec) {
    const chunkEnd = Math.min(cursor + seconds * CHUNK, endSec)
    const url = `${BASE_URL}/kline/${symbol}?interval=${mexcInterval}&start=${cursor}&end=${chunkEnd}`
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

// ── Trade record ──────────────────────────────────────────────────────────────
interface TradeRecord {
  side: "long" | "short"
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  pnl: number
  reason: string
}

function runBacktest(entryCandles: Candle[], signalCandles: Candle[], regimeCandles: Candle[], args: CliArgs): TradeRecord[] {
  const cfg: TrendRiderConfig = {
    ...DEFAULT_TREND_RIDER_CONFIG,
    minStrength: args.minStrength,
    adxMinFloor: args.adxFloor,
    chandelierAtrMult: args.chandelierMult,
    breakevenAtr: args.breakevenAtr,
    pullbackTouchAtr: args.pullbackAtr,
    requireRejectionCandle: !args.noRejection,
    minTrendAge: args.minTrendAge,
    htfTrailUseSwing: args.htfSwing,
  }
  const trades: TradeRecord[] = []
  let position: TrendRiderPosition | null = null
  const NOTIONAL = 1000 // fixed notional per trade for consistent USDT PnL comparison

  // Need enough lookback before we can evaluate; start where structureWindow is satisfied
  const minStart = cfg.structureWindow + cfg.swingLookback * 2 + 5

  // Step 5: iterate entry-tf candles, but build a no-lookahead signal-tf slice
  // for detection. The pointer sigIdx advances monotonically: for each entry
  // candle at time t, we include only signal candles fully closed at or before t.
  // This guarantees zero lookahead — the signal state at entry time t can only
  // see signal candles that have already closed.
  let sigIdx = 0
  let regIdx = 0
  let verificationCount = 0
  
  for (let i = minStart; i < entryCandles.length; i++) {
    const entrySlice = entryCandles.slice(0, i + 1)
    const entryTime = entrySlice[entrySlice.length - 1].time
    
    // Advance signal pointer to include only signal candles FULLY CLOSED at or before entryTime.
    // MEXC uses open-time labels, so close_time = open_time + interval_seconds.
    // This guarantees zero lookahead: we never read a signal candle that hasn't closed yet.
    const sigTfSec = INTERVAL_SECONDS[args.signalTf]
    if (!sigTfSec) throw new Error(`Unknown signal timeframe: ${args.signalTf}`)
    while (sigIdx < signalCandles.length && signalCandles[sigIdx].time + sigTfSec <= entryTime) {
      sigIdx++
    }
    const signalSlice = signalCandles.slice(0, sigIdx)

    // Same no-lookahead pointer for the daily regime feed
    const regTfSec = INTERVAL_SECONDS[args.regimeTf]
    if (!regTfSec) throw new Error(`Unknown regime timeframe: ${args.regimeTf}`)
    while (regIdx < regimeCandles.length && regimeCandles[regIdx].time + regTfSec <= entryTime) {
      regIdx++
    }
    const regimeSlice = regimeCandles.slice(0, regIdx)
    
    // Verification log: prove no lookahead for the first 10 entries
    if (verificationCount < 10 && signalSlice.length > 0) {
      const lastSignalTime = signalSlice[signalSlice.length - 1].time
      const delta = entryTime - lastSignalTime
      console.log(`[VERIFY] entry=${new Date(entryTime * 1000).toISOString()} signal=${new Date(lastSignalTime * 1000).toISOString()} delta=${(delta / 3600).toFixed(1)}h`)
      verificationCount++
    }
    
    // TODO Step 6: split detection (signalSlice) from entry trigger (entrySlice).
    // For now, pass entrySlice to evaluateTrendRider so existing logic still works.
    const signal = evaluateTrendRider(entrySlice, signalSlice.length ? signalSlice : null, position, cfg, regimeSlice.length ? regimeSlice : null)

    if (signal.action === "enter" && !position && signal.side && signal.price != null) {
      const entryFillPrice = signal.side === "long" ? signal.price * (1 + args.slipPct) : signal.price * (1 - args.slipPct)

      // Derive the REAL initial stop directly from structure state at entry —
      // do not rely on a discarded follow-up evaluation. Must use the same
      // buffered formula as the trailing-stop update so entry and trail are
      // consistent, otherwise the very first stop check after entry will
      // compare against a bogus placeholder (e.g. entry price itself) and
      // trigger an instant phantom stop-out.
      // NOTE: detectTrendState (not evaluateTrendRider) is the function that
      // returns the raw state object with structureStopPrice.
      const atrArr = atr(entrySlice, 14)
      const lastAtrAtEntry = atrArr[atrArr.length - 1] || 0
      const stateNow = detectTrendState(signalSlice.length ? signalSlice : entrySlice, null, cfg)

      if (stateNow.structureStopPrice == null) {
        continue // should not happen since entry was validated, but guard anyway
      }

      const initialStop =
        signal.side === "long"
          ? stateNow.structureStopPrice - lastAtrAtEntry * cfg.atrStopBuffer
          : stateNow.structureStopPrice + lastAtrAtEntry * cfg.atrStopBuffer

      position = {
        side: signal.side,
        entryPrice: entryFillPrice,
        entryTime: entryTime,
        stopPrice: initialStop,
        atrAtEntry: lastAtrAtEntry,
        weakStreak: 0,
        peakPrice: entryFillPrice, // seed at entry; updated each candle by the chandelier trail
      }
      continue
    }

    if (signal.action === "exit" && position && signal.price != null) {
      const exitFillPrice = position.side === "long" ? signal.price * (1 - args.slipPct) : signal.price * (1 + args.slipPct)
      const qty = NOTIONAL / position.entryPrice
      const grossPnl =
        position.side === "long" ? (exitFillPrice - position.entryPrice) * qty : (position.entryPrice - exitFillPrice) * qty
      const fees = (position.entryPrice + exitFillPrice) * qty * args.feePct
      const pnl = grossPnl - fees

      trades.push({
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: exitFillPrice,
        entryTime: position.entryTime,
        exitTime: entryTime,
        pnl,
        reason: signal.reason,
      })
      position = null
    }
  }

  return trades
}

function report(trades: TradeRecord[], label: string, notional: number) {
  console.log("\n" + "═".repeat(56))
  console.log(`  ${label}`)
  console.log("═".repeat(56))

  if (trades.length === 0) {
    console.log("  No trades generated.")
    return
  }

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const winRate = wins.length / trades.length
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0
  const expectancy = totalPnl / trades.length

  const pnlSeries = trades.map((t) => t.pnl)
  const meanPnl = expectancy
  const variance = pnlSeries.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / pnlSeries.length
  const stdDev = Math.sqrt(variance)
  const sharpe = stdDev > 0 ? meanPnl / stdDev : 0

  // Track drawdown against a real capital base (NOTIONAL), not raw
  // cumulative PnL starting at zero — starting the peak/equity at 0 causes
  // either a permanently-stuck 0% (if PnL goes negative before ever going
  // positive, since peak never exceeds 0) or a nonsensical blown-up
  // percentage (if peak is a tiny positive number acting as denominator).
  let equity = notional
  let peak = notional
  let maxDD = 0
  for (const t of trades) {
    equity += t.pnl
    peak = Math.max(peak, equity)
    const dd = peak > 0 ? (peak - equity) / peak : 0
    maxDD = Math.max(maxDD, dd)
  }

  const durations = trades.map((t) => (t.exitTime - t.entryTime) / 3600)
  const avgDurationHrs = durations.reduce((s, d) => s + d, 0) / durations.length

  console.log(`  Trades:            ${trades.length}`)
  console.log(`  Win rate:          ${(winRate * 100).toFixed(1)}%`)
  console.log(`  Avg win:           ${avgWin.toFixed(2)} USDT`)
  console.log(`  Avg loss:          ${avgLoss.toFixed(2)} USDT`)
  console.log(`  Expectancy:        ${expectancy.toFixed(2)} USDT/trade`)
  console.log(`  Profit factor:     ${profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:         ${totalPnl.toFixed(2)} USDT`)
  console.log(`  Sharpe (per-trade):${sharpe.toFixed(3)}`)
  console.log(`  Max drawdown:      ${(maxDD * 100).toFixed(1)}%`)
  console.log(`  Avg hold duration: ${avgDurationHrs.toFixed(1)}h`)

  console.log("\n  Per-exit-reason:")
  const byReason = new Map<string, TradeRecord[]>()
  for (const t of trades) {
    const arr = byReason.get(t.reason) ?? []
    arr.push(t)
    byReason.set(t.reason, arr)
  }
  for (const [reason, arr] of byReason) {
    const wr = (arr.filter((t) => t.pnl > 0).length / arr.length) * 100
    const pnl = arr.reduce((s, t) => s + t.pnl, 0)
    console.log(`    ${reason.padEnd(20)} n=${arr.length}  win=${wr.toFixed(1)}%  pnl=${pnl.toFixed(2)}`)
  }

  console.log("\n  Per-side:")
  for (const side of ["long", "short"] as const) {
    const arr = trades.filter((t) => t.side === side)
    if (arr.length === 0) continue
    const wr = (arr.filter((t) => t.pnl > 0).length / arr.length) * 100
    const pnl = arr.reduce((s, t) => s + t.pnl, 0)
    console.log(`    ${side.padEnd(20)} n=${arr.length}  win=${wr.toFixed(1)}%  pnl=${pnl.toFixed(2)}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const end = Math.floor(Date.now() / 1000)
  const start = end - args.days * 86400

  console.log(`Fetching ${args.symbol} entry=${args.entryTf} signal=${args.signalTf} for ${args.days} days...`)
  const entryCandles = await fetchKlinesRange(args.symbol, normalizeInterval(args.entryTf), start, end)
  console.log(`Fetched ${entryCandles.length} entry (${args.entryTf}) candles`)

  const signalCandles = await fetchKlinesRange(args.symbol, normalizeInterval(args.signalTf), start, end)
  console.log(`Fetched ${signalCandles.length} signal (${args.signalTf}) candles`)

  const regimeCandles = await fetchKlinesRange(args.symbol, normalizeInterval(args.regimeTf), start, end)
  console.log(`Fetched ${regimeCandles.length} regime (${args.regimeTf}) candles`)

  console.log(
    `  Config: swingLookback=${DEFAULT_TREND_RIDER_CONFIG.swingLookback} structureWindow=${DEFAULT_TREND_RIDER_CONFIG.structureWindow} ` +
      `emaSlow=${DEFAULT_TREND_RIDER_CONFIG.emaSlowPeriod} adxFloor=${args.adxFloor} minStrength=${args.minStrength} ` +
      `lev=${args.leverage}x fees=${(args.feePct * 100).toFixed(3)}% slip=${(args.slipPct * 100).toFixed(3)}%`
  )

  const trades = runBacktest(entryCandles, signalCandles, regimeCandles, args)
  report(trades, `TREND RIDER [${args.symbol} entry=${args.entryTf} signal=${args.signalTf} ${args.days}d]`, 1000)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

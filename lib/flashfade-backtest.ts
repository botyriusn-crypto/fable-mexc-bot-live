// Flash-fade walk-forward replay (pure, no I/O).
//
// Replays the PRODUCTION detection (detectFlashFade) bar by bar with
// engine-faithful execution: fixed $300 margin @ 3x (see engine.ts tick),
// one position per symbol, maxPositions concurrent cap, SL-first on same-bar
// touches, time exit at maxHoldBars, 2bps taker fee per side.
//
// Deliberately NOT modeled: live fill confirmation, funding, slippage beyond
// the taker fee. Exits in production are managed by the shared trailing
// engine, which can only improve on fixed SL/TP — so this replay is the
// conservative (pessimistic) arm of the gauntlet.

import { detectFlashFade, flashFadeEntryAllowed } from "./flash-fade"
import type { Candle } from "./mexc/public"
import type { BacktestReport, BacktestTrade } from "./scalp-backtest"

export interface FlashBacktestConfig {
  startEquity: number
  marginUsdt?: number
  leverage?: number
  feeBpsPerSide?: number
  maxHoldBars?: number
  warmupBars?: number
  windowBars?: number
  maxPositions?: number
  minMovePct?: number
  minVolumeMultiplier?: number
}

export function runFlashFadeBacktest(
  symbol: string,
  candles: Candle[],
  opts: FlashBacktestConfig,
): BacktestReport {
  const marginUsdt = opts.marginUsdt ?? 300
  const leverage = opts.leverage ?? 3
  const feeFrac = (opts.feeBpsPerSide ?? 2) / 10000
  const maxHold = opts.maxHoldBars ?? 48
  const warmup = opts.warmupBars ?? 30
  const windowBars = opts.windowBars ?? 60
  const maxPositions = opts.maxPositions ?? 2

  interface Open {
    symbol: string
    direction: "long" | "short"
    entry: number
    qty: number
    stop: number
    take: number
    entryBar: number
  }
  const open: Open[] = []
  const trades: BacktestTrade[] = []
  let equity = opts.startEquity
  let peak = equity
  let maxDD = 0

  const closeOne = (o: Open, exit: number, exitBar: number, reason: "tp" | "sl" | "timeout") => {
    const gross = o.direction === "long" ? (exit - o.entry) * o.qty : (o.entry - exit) * o.qty
    const fees = o.qty * o.entry * feeFrac * 2
    const pnl = gross - fees
    equity += pnl
    peak = Math.max(peak, equity)
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100)
    trades.push({
      bar: o.entryBar, direction: o.direction, entry: o.entry, qty: o.qty,
      margin: marginUsdt, stop: o.stop, take: o.take,
      exit, exitBar, pnl, fees, reason, confidence: 0.5,
    })
    open.splice(open.indexOf(o), 1)
  }

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i]
    // Manage open first (SL-first on same-bar touches, then TP, then timeout).
    for (const o of [...open]) {
      const hitSL = o.direction === "long" ? c.low <= o.stop : c.high >= o.stop
      const hitTP = o.direction === "long" ? c.high >= o.take : c.low <= o.take
      if (hitSL) closeOne(o, o.stop, i, "sl")
      else if (hitTP) closeOne(o, o.take, i, "tp")
      else if (i - o.entryBar >= maxHold) closeOne(o, c.close, i, "timeout")
    }
    if (i + 1 >= candles.length) break
    const window = candles.slice(Math.max(0, i - windowBars + 1), i + 1)
    const sig = detectFlashFade(window, {
      minMovePct: opts.minMovePct,
      minVolumeMultiplier: opts.minVolumeMultiplier,
    })
    if (!sig.detected || !sig.direction) continue
    if (!flashFadeEntryAllowed(open.map((o) => ({ symbol: o.symbol })), symbol, maxPositions)) continue
    const entry = candles[i + 1].open
    const qty = (marginUsdt * leverage) / entry
    open.push({
      symbol, direction: sig.direction, entry, qty,
      stop: sig.stopLoss, take: sig.takeProfit, entryBar: i + 1,
    })
    i++ // entry bar consumed
  }
  for (const o of [...open]) closeOne(o, candles[candles.length - 1].close, candles.length - 1, "timeout")

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  return {
    symbol,
    bars: candles.length,
    trades,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl,
    returnPct: (totalPnl / opts.startEquity) * 100,
    maxDrawdownPct: maxDD,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    expectancy: trades.length ? totalPnl / trades.length : 0,
  }
}

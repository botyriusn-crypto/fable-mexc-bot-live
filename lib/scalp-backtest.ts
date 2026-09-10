// Scalp-path backtest engine (pure, no I/O).
//
// Walks candles through the PRODUCTION entry + sizing chain:
//   evaluateScalpSignal -> calculateDynamicSize -> notionalToMarginUsdt
// and simulates SL/TP exits bar by bar.
//
// Deliberately NOT modeled (documented): the ML logistic gate and the
// Lorentzian confirmation (both would only filter entries further), funding
// payments, and slippage beyond a fixed taker fee. This measures raw trigger
// quality under the fixed (post-P0) sizing.

import { computeSnapshot } from "./indicators"
import { evaluateScalpSignal } from "./trend-scalper"
import { calculateDynamicSize, notionalToMarginUsdt } from "./strategy"
import type { Candle } from "./mexc/public"
import type { BotConfig } from "./db/schema"

export interface ScalpBacktestConfig {
  startEquity: number
  leverage: number
  /** Fraction of equity risked per trade, e.g. 0.01. */
  riskPct: number
  /** Per-trade margin cap (positionSizeUsdt). */
  positionBudgetUsdt: number
  /** Taker fee in bps per side, e.g. 2. */
  feeBpsPerSide?: number
  /** Max bars to hold before a time exit. */
  maxHoldBars?: number
  /** Bars skipped at the start (indicator warmup). */
  warmupBars?: number
  /** Trailing window fed to the signal. */
  windowBars?: number
  /** Strategy knobs (mirrors the live scalper test config). */
  scalp: {
    emaFast: number
    emaSlow: number
    rsiPeriod: number
    atrPeriod: number
    rsiOverbought: number
    rsiOversold: number
    allowLong: boolean
    allowShort: boolean
    slAtrMult: number
  }
}

export interface BacktestTrade {
  bar: number
  direction: "long" | "short"
  entry: number
  qty: number
  margin: number
  stop: number
  take: number
  exit: number
  exitBar: number
  pnl: number
  fees: number
  reason: "tp" | "sl" | "timeout"
  confidence: number
}

export interface BacktestReport {
  symbol: string
  bars: number
  trades: BacktestTrade[]
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  returnPct: number
  maxDrawdownPct: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  expectancy: number
}

function buildCfg(scalp: ScalpBacktestConfig["scalp"], leverage: number): BotConfig {
  return {
    symbol: "BACKTEST",
    timeframe: "Min15",
    ...scalp,
    leverage,
    positionSizeUsdt: 0,
  } as unknown as BotConfig
}

export function runScalpBacktest(
  symbol: string,
  candles: Candle[],
  opts: ScalpBacktestConfig,
): BacktestReport {
  const feeFrac = (opts.feeBpsPerSide ?? 2) / 10000
  const maxHold = opts.maxHoldBars ?? 48
  const warmup = opts.warmupBars ?? 80
  const windowBars = opts.windowBars ?? 200
  const cfg = buildCfg(opts.scalp, opts.leverage)

  let equity = opts.startEquity
  let peak = equity
  let maxDD = 0
  const trades: BacktestTrade[] = []
  let open: {
    direction: "long" | "short"
    entry: number
    qty: number
    margin: number
    stop: number
    take: number
    entryBar: number
    confidence: number
  } | null = null

  const closePosition = (exit: number, exitBar: number, reason: "tp" | "sl" | "timeout") => {
    if (!open) return
    const gross =
      open.direction === "long" ? (exit - open.entry) * open.qty : (open.entry - exit) * open.qty
    const notional = open.qty * open.entry
    const fees = notional * feeFrac * 2
    const pnl = gross - fees
    equity += pnl
    peak = Math.max(peak, equity)
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100)
    trades.push({ ...open, exit, exitBar, pnl, fees, reason, bar: open.entryBar })
    open = null
  }

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i]
    if (open) {
      const hitSL =
        open.direction === "long" ? c.low <= open.stop : c.high >= open.stop
      const hitTP =
        open.direction === "long" ? c.high >= open.take : c.low <= open.take
      // Conservative: stop first when both print on the same bar.
      if (hitSL) closePosition(open.stop, i, "sl")
      else if (hitTP) closePosition(open.take, i, "tp")
      else if (i - open.entryBar >= maxHold) closePosition(c.close, i, "timeout")
      continue
    }
    const window = candles.slice(Math.max(0, i - windowBars), i + 1)
    const snap = computeSnapshot(window, cfg)
    const sig = evaluateScalpSignal(snap, window, cfg, equity)
    if (!sig.triggered || !sig.direction || sig.stopLoss == null || sig.takeProfit == null) continue
    if (i + 1 >= candles.length) break
    // Fixed (post-P0) sizing chain, exactly as the engine books it.
    const { sizeUsdt } = calculateDynamicSize(equity, sig.atr, snap.price, opts.riskPct)
    const suggested = sizeUsdt > 0 && sig.confidence > 0 ? sizeUsdt * sig.confidence : 0
    const margin = Math.min(
      notionalToMarginUsdt(suggested, opts.leverage),
      opts.positionBudgetUsdt,
    )
    if (margin < 5) continue
    const entry = candles[i + 1].open
    const qty = (margin * opts.leverage) / entry
    open = {
      direction: sig.direction,
      entry,
      qty,
      margin,
      stop: sig.stopLoss,
      take: sig.takeProfit,
      entryBar: i + 1,
      confidence: sig.confidence,
    }
    i++ // entry bar consumed
  }
  if (open) closePosition(candles[candles.length - 1].close, candles.length - 1, "timeout")

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

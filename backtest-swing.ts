// backtest-swing.ts — replay the REAL Swing Breakout (4H) logic
// (evaluateSwingEntry / evaluateSwingExit from lib/swing-breakout.ts) over
// historical candles and report win rate, expectancy, Sharpe, max drawdown,
// and profit factor.
//
// Usage:
//   pnpm tsx backtest-swing.ts --symbol BTC_USDT --days 365
//   pnpm tsx backtest-swing.ts --symbol ETH_USDT --days 365 --risk 0.02 --leverage 1
//
// Mirrors production exactly: entries are evaluated against a rolling
// ~300-candle (50-day) window ending at each bar, matching what
// runSwingBreakoutTick() actually fetches on every live tick — not an
// ever-growing history, which would give the EMA200 a different warm-up
// period than production ever sees.

import { fetch4hCandles, evaluateSwingEntry, evaluateSwingExit, type Candle } from "./lib/swing-breakout"

const TAKER_FEE = 0.0002
const ENTRY_WINDOW = 300 // matches production's 50-day fetch (~6 candles/day)
const EXIT_WINDOW = 30   // matches production's 5-day fetch

interface Args {
  symbol: string
  days: number
  risk: number
  leverage: number
  equity: number
  stopAtr: number
  targetAtr: number
}

function parseArgs(argv: string[]): Args {
  const a: Args = { symbol: "BTC_USDT", days: 365, risk: 0.02, leverage: 1, equity: 10000, stopAtr: 3, targetAtr: 6 }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1]
    switch (k) {
      case "--symbol": a.symbol = v; i++; break
      case "--days": a.days = Number(v); i++; break
      case "--risk": a.risk = Number(v); i++; break
      case "--leverage": a.leverage = Number(v); i++; break
      case "--equity": a.equity = Number(v); i++; break
      case "--stop-atr": a.stopAtr = Number(v); i++; break
      case "--target-atr": a.targetAtr = Number(v); i++; break
    }
  }
  return a
}

interface OpenPos {
  side: "long" | "short"
  entryPrice: number
  stopLoss: number
  takeProfit: number
  quantity: number
  sizeUsdt: number
  entryBar: number
  entryTime: number
}

interface ClosedTrade {
  side: "long" | "short"
  entryPrice: number
  exitPrice: number
  pnl: number
  fees: number
  reason: string
  barsHeld: number
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  console.log(`Fetching ${a.symbol} 4H candles for ${a.days} days...`)
  const candles = await fetch4hCandles(a.symbol, a.days)
  console.log(`Fetched ${candles.length} candles`)

  if (candles.length < ENTRY_WINDOW + 10) {
    console.log(`Not enough data — need at least ${ENTRY_WINDOW + 10} candles, got ${candles.length}. Try a larger --days.`)
    return
  }

  let equity = a.equity
  const initialEquity = equity
  let pos: OpenPos | null = null
  const trades: ClosedTrade[] = []
  const equityCurve: number[] = [equity]

  for (let i = ENTRY_WINDOW - 1; i < candles.length; i++) {
    if (pos) {
      const exitWindow = candles.slice(Math.max(0, i - EXIT_WINDOW + 1), i + 1)
      const exit = evaluateSwingExit(exitWindow, pos)
      if (exit?.exit) {
        const grossPnl = (exit.exitPrice - pos.entryPrice) * pos.quantity * (pos.side === "long" ? 1 : -1)
        const closeFee = pos.sizeUsdt * TAKER_FEE
        const netPnl = grossPnl - closeFee
        equity += netPnl
        trades.push({
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: exit.exitPrice,
          pnl: netPnl,
          fees: closeFee, // openFee was already deducted from equity at entry time
          reason: exit.reason,
          barsHeld: i - pos.entryBar,
        })
        equityCurve.push(equity)
        pos = null
      }
    }

    if (!pos) {
      const entryWindow = candles.slice(Math.max(0, i - ENTRY_WINDOW + 1), i + 1)
      const signal = evaluateSwingEntry(entryWindow, a.stopAtr, a.targetAtr)
      if (signal?.side) {
        const riskUsdt = equity * a.risk
        const sizeUsdt = riskUsdt * a.leverage
        const quantity = sizeUsdt / signal.price
        const openFee = sizeUsdt * TAKER_FEE
        equity -= openFee
        pos = {
          side: signal.side,
          entryPrice: signal.price,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          quantity,
          sizeUsdt,
          entryBar: i,
          entryTime: candles[i].time,
        }
      }
    }
  }

  // Report
  console.log("\n" + "=".repeat(56))
  console.log(`  SWING BREAKOUT (4H) — ${a.symbol} (SL ${a.stopAtr}x / TP ${a.targetAtr}x ATR)`)
  console.log("=".repeat(56))
  console.log(`  Trades:            ${trades.length}`)

  if (trades.length === 0) {
    console.log("  No trades in this period — try a longer --days window,")
    console.log("  or this symbol simply didn't produce a qualifying")
    console.log("  20-bar breakout + EMA200-aligned setup in this window.")
    return
  }

  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const winRate = wins.length / trades.length
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
  const expectancy = totalPnl / trades.length

  const pnlList = trades.map(t => t.pnl)
  const meanPnl = pnlList.reduce((a, b) => a + b, 0) / pnlList.length
  const variance = pnlList.reduce((s, v) => s + (v - meanPnl) ** 2, 0) / pnlList.length
  const stdPnl = Math.sqrt(variance)
  const sharpe = stdPnl > 0 ? meanPnl / stdPnl : 0

  let peak = equityCurve[0], maxDD = 0
  for (const e of equityCurve) {
    if (e > peak) peak = e
    const dd = (peak - e) / peak
    if (dd > maxDD) maxDD = dd
  }

  console.log(`  Win rate:          ${(winRate * 100).toFixed(1)}%`)
  console.log(`  Avg win:           ${avgWin.toFixed(2)} USDT`)
  console.log(`  Avg loss:          ${avgLoss.toFixed(2)} USDT`)
  console.log(`  Expectancy:        ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)} USDT/trade`)
  console.log(`  Profit factor:     ${profitFactor.toFixed(2)}`)
  console.log(`  Total PnL:         ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT (${((totalPnl / initialEquity) * 100).toFixed(1)}%)`)
  console.log(`  Sharpe (per-trade):${sharpe.toFixed(3)}`)
  console.log(`  Max drawdown:      ${(maxDD * 100).toFixed(1)}%`)

  const byReason: Record<string, { n: number; pnl: number }> = {}
  for (const t of trades) {
    if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 }
    byReason[t.reason].n++
    byReason[t.reason].pnl += t.pnl
  }
  console.log("\n  By exit reason:")
  for (const [reason, s] of Object.entries(byReason)) {
    console.log(`    ${reason.padEnd(12)} n=${s.n}  pnl=${s.pnl.toFixed(2)}`)
  }

  const longs = trades.filter(t => t.side === "long")
  const shorts = trades.filter(t => t.side === "short")
  console.log("\n  By side:")
  console.log(`    long   n=${longs.length}  win=${longs.length ? ((longs.filter(t => t.pnl > 0).length / longs.length) * 100).toFixed(1) : "0.0"}%  pnl=${longs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`)
  console.log(`    short  n=${shorts.length}  win=${shorts.length ? ((shorts.filter(t => t.pnl > 0).length / shorts.length) * 100).toFixed(1) : "0.0"}%  pnl=${shorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`)
}

main().catch(err => {
  console.error("Backtest failed:", err)
  process.exit(1)
})

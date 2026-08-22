// 4H Swing Breakout — validated strategy (Phase G +dir)
// Entry: 20-bar breakout, only with trend (price > EMA200 for longs, < for shorts)
// Exit: 3×ATR stop, 6×ATR target, or 10-bar trailing exit
// Risk: 2% of equity per trade, 1x leverage

import { db } from "./db"
import { positions, botConfig, trades } from "./db/schema"
import { eq, and, sql } from "drizzle-orm"

interface Candle { time: number; high: number; low: number; close: number; open: number }
interface SwingConfig {
  symbol: string
  riskPct: number  // 0.02 = 2% of equity
  leverage: number
}

const TAKER_FEE = 0.0002
// SWING_SYMBOLS is now read from botConfig.swingSymbols

async function fetch4hCandles(symbol: string, days: number): Promise<Candle[]> {
  const isec = 4 * 3600, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Hour4&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, high, low, close, open } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], high: high[i], low: low[i], close: close[i], open: open[i] })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

function ema(v: number[], p: number): number[] {
  const o = [v[0]]; const k = 2 / (p + 1)
  for (let i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k)
  return o
}

function atr(c: Candle[], p = 14): number[] {
  const o = new Array(c.length).fill(0); let a = 0
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    a = i <= p ? (a * (i - 1) + tr) / i : (a * (p - 1) + tr) / p
    o[i] = a
  }
  return o
}

async function checkEntrySignal(symbol: string): Promise<{ side: "long" | "short" | null; price: number; stopLoss: number; takeProfit: number; confidence: number } | null> {
  const candles = await fetch4hCandles(symbol, 30)
  if (candles.length < 210) return null

  const closes = candles.map(c => c.close)
  const e200 = ema(closes, 200)
  const a = atr(candles)

  const last = candles[candles.length - 1]
  const price = last.close
  const prevClose = candles[candles.length - 2].close

  // 20-bar high/low
  const hh20 = Math.max(...candles.slice(-21, -1).map(c => c.high))
  const ll20 = Math.min(...candles.slice(-21, -1).map(c => c.low))

  const atrVal = a[a.length - 1]
  const e200Val = e200[e200.length - 1]

  // Long: breakout above 20-high AND price > EMA200
  if (price > hh20 && price > e200Val) {
    return {
      side: "long",
      price,
      stopLoss: price - 3 * atrVal,
      takeProfit: price + 6 * atrVal,
      confidence: 70,
    }
  }

  // Short: breakout below 20-low AND price < EMA200
  if (price < ll20 && price < e200Val) {
    return {
      side: "short",
      price,
      stopLoss: price + 3 * atrVal,
      takeProfit: price - 6 * atrVal,
      confidence: 70,
    }
  }

  return null
}

async function checkExitSignal(symbol: string, pos: any): Promise<{ exit: boolean; reason: string; exitPrice: number } | null> {
  const candles = await fetch4hCandles(symbol, 5)
  if (candles.length < 20) return null

  const last = candles[candles.length - 1]
  const price = last.close

  // Stop-loss hit
  if (pos.side === "long" && last.low <= pos.stopLoss) {
    return { exit: true, reason: "stop-loss", exitPrice: pos.stopLoss }
  }
  if (pos.side === "short" && last.high >= pos.stopLoss) {
    return { exit: true, reason: "stop-loss", exitPrice: pos.stopLoss }
  }

  // Take-profit hit
  if (pos.side === "long" && last.high >= pos.takeProfit) {
    return { exit: true, reason: "take-profit", exitPrice: pos.takeProfit }
  }
  if (pos.side === "short" && last.low <= pos.takeProfit) {
    return { exit: true, reason: "take-profit", exitPrice: pos.takeProfit }
  }

  // Trailing exit: 10-bar low break (long) or 10-bar high break (short)
  const ll10 = Math.min(...candles.slice(-10).map(c => c.low))
  const hh10 = Math.max(...candles.slice(-10).map(c => c.high))

  if (pos.side === "long" && price < ll10) {
    return { exit: true, reason: "trail", exitPrice: price }
  }
  if (pos.side === "short" && price > hh10) {
    return { exit: true, reason: "trail", exitPrice: price }
  }

  return null
}

async function openPaperPosition(symbol: string, signal: any, cfg: SwingConfig) {
  const [botCfg] = await db.select().from(botConfig).limit(1)
  if (!botCfg) throw new Error("No bot config found")

  const equity = botCfg.paperBalance
  const riskUsdt = equity * cfg.riskPct
  const sizeUsdt = riskUsdt * cfg.leverage
  const quantity = sizeUsdt / signal.price

  // Check if we already have an open position in this symbol
  const existing = await db.select().from(positions)
    .where(and(eq(positions.symbol, symbol), eq(positions.status, "open")))
    .limit(1)

  if (existing.length > 0) {
    console.log(`[Swing] ${symbol}: already have open position, skipping`)
    return
  }

  // Open fee
  const openFee = sizeUsdt * TAKER_FEE

  // Insert position
  const [pos] = await db.insert(positions).values({
    symbol,
    side: signal.side,
    entryPrice: signal.price,
    quantity,
    sizeUsdt,
    leverage: cfg.leverage,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    status: "open",
    strategy: "swing",
    entryConfidence: signal.confidence,
    remainingQuantity: quantity,
    partialExitCount: 0,
    breakEvenMoved: false,
  }).returning()

  // Update paper balance (deduct open fee)
  await db.update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} - ${openFee}` })
    .where(eq(botConfig.id, botCfg.id))

  console.log(`[Swing] Opened ${signal.side} ${symbol} @ ${signal.price.toFixed(2)}, size $${sizeUsdt.toFixed(2)}, SL ${signal.stopLoss.toFixed(2)}, TP ${signal.takeProfit.toFixed(2)}`)
}

async function closePaperPosition(pos: any, exitPrice: number, reason: string) {
  const [botCfg] = await db.select().from(botConfig).limit(1)
  if (!botCfg) throw new Error("No bot config found")

  const grossPnl = (exitPrice - pos.entryPrice) * pos.remainingQuantity * (pos.side === "long" ? 1 : -1)
  const closeFee = pos.sizeUsdt * TAKER_FEE
  const netPnl = grossPnl - closeFee

  // Insert trade record
  await db.insert(trades).values({
    positionId: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    sizeUsdt: pos.sizeUsdt,
    leverage: pos.leverage,
    pnl: netPnl,
    fees: closeFee,
    exitReason: reason,
    strategy: "swing",
    entryConfidence: pos.entryConfidence,
    openedAt: pos.openedAt,
    partial: false,
  })

  // Close position
  await db.update(positions)
    .set({ status: "closed", closedAt: sql`NOW()` })
    .where(eq(positions.id, pos.id))

  // Update paper balance (add net PnL)
  await db.update(botConfig)
    .set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` })
    .where(eq(botConfig.id, botCfg.id))

  console.log(`[Swing] Closed ${pos.symbol} @ ${exitPrice.toFixed(2)}, ${reason}, PnL $${netPnl.toFixed(2)}`)
}

export async function runSwingBreakoutTick() {
  const [botCfg] = await db.select().from(botConfig).limit(1)
  if (!botCfg || botCfg.status !== "running") {
    console.log("[Swing] Bot not running, skipping swing tick")
    return
  }

  if (!botCfg.swingEnabled) {
    console.log("[Swing] Swing strategy disabled, skipping")
    return
  }

  const swingSymbols: string[] = botCfg.swingSymbols || ["BTC_USDT", "ETH_USDT"]
  const cfg: SwingConfig = {
    symbol: "",
    riskPct: botCfg.swingRiskPct || 0.02,
    leverage: botCfg.swingLeverage || 1,
  }

  console.log("[Swing] === Swing Breakout Tick ===")

  for (const symbol of swingSymbols) {
    try {
      // Check for exits on open positions
      const openPositions = await db.select().from(positions)
        .where(and(eq(positions.symbol, symbol), eq(positions.status, "open"), eq(positions.strategy, "swing")))
        .limit(10)

      for (const pos of openPositions) {
        const exit = await checkExitSignal(symbol, pos)
        if (exit?.exit) {
          await closePaperPosition(pos, exit.exitPrice, exit.reason)
        }
      }

      // Check for entries
      const signal = await checkEntrySignal(symbol)
      if (signal?.side) {
        cfg.symbol = symbol
        await openPaperPosition(symbol, signal, cfg)
      }
    } catch (err) {
      console.error(`[Swing] Error processing ${symbol}:`, err)
    }
  }

  console.log("[Swing] === Tick complete ===")
}

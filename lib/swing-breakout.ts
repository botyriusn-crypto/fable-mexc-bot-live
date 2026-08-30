// 4H Swing Breakout — validated strategy (Phase G +dir)
// Entry: 20-bar breakout, only with trend (price > EMA200 for longs, < for shorts)
// Exit: 3×ATR stop, 6×ATR target, or 10-bar trailing exit
// Risk: 2% of equity per trade, 1x leverage

import { db } from "./db"
import { positions, botConfig, trades } from "./db/schema"
import { eq, and, sql } from "drizzle-orm"
import { getExchangeClient, type Exchange } from "./exchange"
import { rsi, adx, volumeConfirmation } from "./indicators"

export interface Candle { time: number; high: number; low: number; close: number; open: number; volume: number }
interface SwingConfig {
  symbol: string
  riskPct: number  // 0.02 = 2% of equity
  leverage: number
}

const TAKER_FEE = 0.0002
// SWING_SYMBOLS is now read from botConfig.swingSymbols

export async function fetch4hCandles(symbol: string, days: number, exchange: Exchange = "mexc"): Promise<Candle[]> {
  // Venue-aware: route through the exchange client so the swing strategy
  // respects the Bybit/Gate/MEXC switch instead of hardcoding MEXC. 4H bars
  // = 6/day, so `days` days ≈ `days * 6` candles. The canonical Candle
  // carries volume, which the edge filters below depend on.
  const limit = Math.max(30, Math.ceil(days * 6))
  const candles = await getExchangeClient(exchange).fetchKlines(symbol, "Hour4", limit)
  candles.sort((a, b) => a.time - b.time)
  return candles.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

export function ema(v: number[], p: number): number[] {
  const o = [v[0]]; const k = 2 / (p + 1)
  for (let i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k)
  return o
}

export function atr(c: Candle[], p = 14): number[] {
  const o = new Array(c.length).fill(0); let a = 0
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    a = i <= p ? (a * (i - 1) + tr) / i : (a * (p - 1) + tr) / p
    o[i] = a
  }
  return o
}

export function evaluateSwingEntry(candles: Candle[], stopAtrMult: number = 3, targetAtrMult: number = 6): { side: "long" | "short" | null; price: number; stopLoss: number; takeProfit: number; confidence: number } | null {
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

  // ── Edge filters (the "no real edge" fix) ──────────────────────────
  // 1. Trend strength: ADX must confirm a real trend, not sideways chop.
  const adxArr = adx(candles)
  const adxVal = adxArr[adxArr.length - 1]
  const trending = adxVal >= 20

  // 2. Volume: the breakout must be backed by above-average volume,
  //    otherwise it's a low-liquidity poke that will fade.
  const volConfirmed = volumeConfirmation(candles, 1.5)

  // 3. Extended-move guard: reject entries when price is stretched too far
  //    from EMA200 (blow-off top / capitulation bottom). This is the fix for
  //    "bought LINK right before it crashed".
  const stretch = (price - e200Val) / e200Val
  const notExtended = Math.abs(stretch) <= 0.15

  // 4. RSI: don't buy overbought, don't short oversold.
  const rsiArr = rsi(closes, 14)
  const rsiVal = rsiArr[rsiArr.length - 1]

  // Long: breakout above 20-high AND price > EMA200
  if (price > hh20 && price > e200Val) {
    if (!trending || !volConfirmed || !notExtended || rsiVal >= 70) return null
    return {
      side: "long",
      price,
      stopLoss: price - stopAtrMult * atrVal,
      takeProfit: price + targetAtrMult * atrVal,
      confidence: 70,
    }
  }

  // Short: breakout below 20-low AND price < EMA200
  if (price < ll20 && price < e200Val) {
    if (!trending || !volConfirmed || !notExtended || rsiVal <= 30) return null
    return {
      side: "short",
      price,
      stopLoss: price + stopAtrMult * atrVal,
      takeProfit: price - targetAtrMult * atrVal,
      confidence: 70,
    }
  }

  return null
}

export function evaluateSwingExit(candles: Candle[], pos: any): { exit: boolean; reason: string; exitPrice: number } | null {
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
  const exchange = (botCfg.exchange as Exchange) || "mexc"
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

      if (openPositions.length > 0) {
        const exitCandles = await fetch4hCandles(symbol, 5, exchange)
        for (const pos of openPositions) {
          const exit = evaluateSwingExit(exitCandles, pos)
          if (exit?.exit) {
            await closePaperPosition(pos, exit.exitPrice, exit.reason)
          }
        }
      }

      // Check for entries. FIXED: was fetching only 30 days (~180 4H
      // candles), always short of the 210-candle minimum needed for the
      // EMA200 calculation — meaning this could never actually signal,
      // regardless of market conditions. 50 days (~300 candles) gives
      // comfortable headroom above the 210 minimum.
      const entryCandles = await fetch4hCandles(symbol, 50, exchange)
      const signal = evaluateSwingEntry(entryCandles)
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

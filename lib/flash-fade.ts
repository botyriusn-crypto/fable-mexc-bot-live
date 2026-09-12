import type { Candle } from "./mexc/public"
import { and, eq } from "drizzle-orm"
import { db } from "./db"
import { botLogs, positions } from "./db/schema"

export interface FlashFadeConfig {
  enabled: boolean; minMovePct: number; minVolumeMultiplier: number
  positionSizeUsdt: number; leverage: number; maxPositions: number
}

export interface FlashFadeSignal {
  detected: boolean; direction: "long" | "short" | null
  entryPrice: number; stopLoss: number; takeProfit: number
  reason: string; movePct: number; volumeMultiplier: number
}

export function detectFlashFade(candles: Candle[], config?: Partial<FlashFadeConfig>): FlashFadeSignal {
  // NB: explicit `??` (not spread) — `{...defaults, ...partial}` lets an
  // explicitly-passed `undefined` silently erase a default, disabling the
  // threshold it was meant to keep (caught by walk-forward replay tests).
  const cfg = {
    enabled: config?.enabled ?? true,
    minMovePct: config?.minMovePct ?? 20,
    minVolumeMultiplier: config?.minVolumeMultiplier ?? 5,
    positionSizeUsdt: config?.positionSizeUsdt ?? 300,
    leverage: config?.leverage ?? 3,
    maxPositions: config?.maxPositions ?? 2,
  }
  if (candles.length < 30) return { detected: false, direction: null, entryPrice: 0, stopLoss: 0, takeProfit: 0, reason: "Need 30+ candles", movePct: 0, volumeMultiplier: 0 }
  
  const current = candles[candles.length - 1], previous = candles[candles.length - 2]
  const movePct = ((current.close - previous.close) / previous.close) * 100
  const avgVolume = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const volumeMultiplier = avgVolume > 0 ? current.volume / avgVolume : 1
  
  if (Math.abs(movePct) < cfg.minMovePct || volumeMultiplier < cfg.minVolumeMultiplier) {
    return { detected: false, direction: null, entryPrice: 0, stopLoss: 0, takeProfit: 0, reason: "Below threshold", movePct: Math.abs(movePct), volumeMultiplier }
  }
  
  const direction = movePct > 0 ? "short" : "long"
  const entryPrice = direction === "short" ? current.high : current.low
  const wickRange = Math.abs(current.high - current.low)
  const stopLoss = direction === "short" ? entryPrice + wickRange * 0.15 : entryPrice - wickRange * 0.15
  const takeProfit = previous.close
  
  return { detected: true, direction, entryPrice, stopLoss, takeProfit, reason: `${direction.toUpperCase()} fade: ${Math.abs(movePct).toFixed(1)}% move`, movePct: Math.abs(movePct), volumeMultiplier }
}

// Pure entry gate (unit-testable): never stack a second flash-fade position
// on the same symbol, and cap total concurrent flash-fade positions at
// config.maxPositions. A choppy listing printing back-to-back ±20% candles
// would otherwise open overlapping positions on the same coin.
export function flashFadeEntryAllowed(
  openFlashPositions: { symbol: string }[],
  symbol: string,
  maxPositions: number,
): boolean {
  if (openFlashPositions.some((p) => p.symbol === symbol)) return false
  if (openFlashPositions.length >= maxPositions) return false
  return true
}

export async function executeFlashFade(symbol: string, timeframe: string, signal: FlashFadeSignal, config: FlashFadeConfig): Promise<boolean> {
  if (!signal.detected || !signal.direction) return false
  const open = await db.select({ symbol: positions.symbol }).from(positions)
    .where(and(eq(positions.status, "open"), eq(positions.strategy, "flash-fade")))
  // Skip silently, like below-threshold signals: detection runs every tick per
  // coin, so a skip log here would spam on every tick while a position is open.
  if (!flashFadeEntryAllowed(open, symbol, config.maxPositions)) return false
  const quantity = (config.positionSizeUsdt * config.leverage) / signal.entryPrice
  await db.insert(positions).values({
    symbol, timeframe, side: signal.direction, entryPrice: signal.entryPrice,
    sizeUsdt: config.positionSizeUsdt, quantity, leverage: config.leverage,
    stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
    strategy: "flash-fade", status: "open",
  })
  await db.insert(botLogs).values({ level: "trade", message: `Flash Fade ${symbol}: ${signal.reason}` })
  return true
}

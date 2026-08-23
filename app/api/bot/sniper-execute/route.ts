import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { openPosition } from "@/lib/engine"
import { computeSnapshot } from "@/lib/indicators"
import { getExchangeClient } from "@/lib/exchange"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    console.log("[Sniper Execute] Received:", JSON.stringify(body))

    let { symbol, direction, entryPrice, stopLoss, takeProfit, confidence, timeframe = "Min5" } = body

    if (!symbol || !direction) {
      return NextResponse.json({ error: "Missing symbol or direction" }, { status: 400 })
    }

    // Get current config
    const cfgRows = await db.select().from(botConfig).where(eq(botConfig.id, 1))
    if (cfgRows.length === 0) {
      return NextResponse.json({ error: "Bot config not found" }, { status: 500 })
    }
    const cfg = cfgRows[0]
    const exchange = getExchangeClient(cfg.exchange as any)

    // Fill in entry price from live ticker if missing
    let entry = Number(entryPrice) || 0
    if (!entry) {
      const ticker = await exchange.fetchTicker(symbol)
      entry = Number(ticker.lastPrice)
    }

    // Fetch candles for snapshot + ATR-based SL/TP fallback
    const candles = await exchange.fetchKlines(symbol, timeframe, 200)
    if (candles.length < 60) {
      return NextResponse.json({ error: "Insufficient candle data" }, { status: 500 })
    }

    // Compute ATR for fallback stops
    let trSum = 0
    for (let i = candles.length - 14; i < candles.length; i++) {
      trSum += Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    }
    const atr = trSum / 14
    const dir = direction === "long" ? 1 : -1

    // Fill in SL/TP if missing (1.5x ATR stop, 3x ATR target)
    let sl = Number(stopLoss) || (entry - dir * atr * 1.5)
    let tp = Number(takeProfit) || (entry + dir * atr * 3)

    // Build market config (same as live sniper path)
    const marketCfg = {
      ...cfg,
      symbol,
      timeframe,
      leverage: cfg.sniperLeverage ?? cfg.leverage,
      positionSizeUsdt: cfg.sniperPositionSizeUsdt ?? cfg.positionSizeUsdt,
    }

    const snap = computeSnapshot(candles, marketCfg)
    snap.price = entry

    const features = { ...snap.features, sideLong: dir }

    const used = await openPosition(
      marketCfg,
      direction,
      snap,
      Number(confidence || 0.5),
      features,
      "sniper",
      { stopLoss: sl, takeProfit: tp, sizeUsdtOverride: marketCfg.positionSizeUsdt }
    )

    return NextResponse.json({
      success: true,
      message: `✅ ${direction.toUpperCase()} ${symbol} opened (${used.toFixed(2)} USDT)`,
      position: { symbol, direction, entry, stopLoss: sl, takeProfit: tp, sizeUsdt: used },
    })
  } catch (e: any) {
    console.error("[Sniper Execute] Error:", e)
    return NextResponse.json({ error: e.message || "Execution failed" }, { status: 500 })
  }
}

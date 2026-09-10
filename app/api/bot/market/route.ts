import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getConfig } from "@/lib/engine"
import { fetchMarkets as fetchMexcMarkets } from "@/lib/mexc/public"

export const dynamic = "force-dynamic"

const VALID_EXCHANGES = ["mexc", "gate", "bybit"] as const

export async function GET(request: Request) {
  try {
    const cfg = await getConfig()
    const requested = new URL(request.url).searchParams.get("exchange")?.toLowerCase()
    const exchange = (VALID_EXCHANGES as readonly string[]).includes(requested ?? "")
      ? (requested as string)
      : (cfg.exchange || "mexc")

    let markets: any[] = []
    if (exchange === "bybit") {
      const { fetchMarkets } = await import("@/lib/bybit/public")
      markets = await fetchMarkets()
    } else if (exchange === "gate") {
      const { gateAdapter } = await import("@/lib/exchange/gate")
      markets = await gateAdapter.fetchMarkets()
    } else {
      markets = await fetchMexcMarkets()
    }

    return NextResponse.json({
      markets: markets.map((m: any) => ({
        symbol: m.symbol,
        displayName: (m.displayName ?? m.symbol).replace('_', '/'),
        priceScale: m.priceScale ?? 4,
        maxLeverage: m.maxLeverage ?? 20,
      })),
      exchange,
      count: markets.length,
      timeframes: ["Min1", "Min5", "Min15", "Min30", "Min60", "Hour4", "Hour8", "Day1"],
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to fetch markets" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe, leverage, positionSizeUsdt } = body
    
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }

    await db.update(botConfig).set({
      symbol: symbol.toUpperCase(),
      timeframe,
      ...(leverage ? { leverage: Number(leverage) } : {}),
      ...(positionSizeUsdt != null ? { positionSizeUsdt: Number(positionSizeUsdt) } : {}),
    }).where(eq(botConfig.id, 1))

    return NextResponse.json({ ok: true, symbol: symbol.toUpperCase(), timeframe })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Market switch failed" }, { status: 500 })
  }
}

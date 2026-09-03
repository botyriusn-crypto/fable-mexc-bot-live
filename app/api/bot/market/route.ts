import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getConfig } from "@/lib/engine"
import { getExchangeClient } from "@/lib/exchange"
import { fetchMarkets as fetchMexcMarkets } from "@/lib/mexc/public"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const cfg = await getConfig()
    const exchange = getExchangeClient(cfg.exchange)
    
    let markets: any[] = []
    if (cfg.exchange === "bybit") {
      const { fetchMarkets } = await import("@/lib/bybit/public")
      markets = await fetchMarkets()
    } else {
      markets = await fetchMexcMarkets()
    }
    
    return NextResponse.json({
      markets: markets.map((m: any) => ({
        symbol: m.symbol,
        displayName: m.symbol.replace('_', '/'),
        priceScale: m.priceScale ?? 4,
        maxLeverage: m.maxLeverage ?? 20,
      })),
      exchange: cfg.exchange,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to fetch markets" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { symbol, timeframe, leverage } = body
    
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: "symbol and timeframe required" }, { status: 400 })
    }

    await db.update(botConfig).set({
      symbol: symbol.toUpperCase(),
      timeframe,
      ...(leverage ? { leverage: Number(leverage) } : {}),
    }).where(eq(botConfig.id, 1))

    return NextResponse.json({ ok: true, symbol: symbol.toUpperCase(), timeframe })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Market switch failed" }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { fetchMarkets } from "@/lib/mexc/public"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const markets = await fetchMarkets()
    return NextResponse.json({
      markets: markets.map((m: any) => ({
        symbol: m.symbol,
        displayName: m.symbol.replace('_', '/'),
        priceScale: m.priceScale ?? 4,
        maxLeverage: m.maxLeverage ?? 20,
      })),
      exchange: 'mexc',
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to fetch markets" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // Verify API key authentication
  const authError = verifyApiKey(request)
  if (authError) return authError
  
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

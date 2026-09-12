import { NextResponse } from "next/server"
import { getConfig } from "@/lib/engine"
import { getExchangeClient, type Exchange } from "@/lib/exchange"
import {
  pickWinner,
  rankTrendCandidates,
  screenUniverse,
  type UniverseRow,
} from "@/lib/trend-candidate"

export const dynamic = "force-dynamic"

const VALID_EXCHANGES = ["mexc", "gate", "bybit"] as const
const KLINES_LIMIT = 100
const CONCURRENCY = 3

interface RawTicker {
  symbol: string
  lastPrice: number
  fundingRate?: number
  volume24?: number
  amount24?: number
  turnover24h?: number
  riseFallRate?: number
  riseFallRate24h?: number
}

function toUniverseRow(t: RawTicker): UniverseRow {
  const turnover =
    t.turnover24h ?? t.amount24 ?? (t.volume24 != null && t.lastPrice ? t.volume24 * t.lastPrice : 0)
  return {
    symbol: t.symbol,
    turnover24h: turnover,
    riseFallRate24h: t.riseFallRate24h ?? t.riseFallRate ?? 0,
    fundingRate: t.fundingRate ?? 0,
    // Feeds the sub-cent pre-screen: PEPE-class coins never reach deep scoring.
    lastPrice: t.lastPrice,
  }
}

async function fetchTickers(exchange: string): Promise<RawTicker[]> {
  if (exchange === "bybit") {
    const { fetchAllTickers } = await import("@/lib/bybit/public")
    return fetchAllTickers()
  }
  if (exchange === "gate") {
    const { fetchAllTickers } = await import("@/lib/gateio/public")
    return fetchAllTickers()
  }
  const { fetchAllTickers } = await import("@/lib/mexc/public")
  return fetchAllTickers()
}

/**
 * GET /api/bot/scan-trend?exchange=mexc&top=8
 * Screens the whole exchange universe on 24h stats, deep-scores the top
 * candidates on 15m klines, and returns the ranked list plus the winner for
 * auto-select into the MAINBAR coin picker.
 */
export async function GET(request: Request) {
  try {
    const cfg = await getConfig()
    const params = new URL(request.url).searchParams
    const requested = params.get("exchange")?.toLowerCase()
    const exchange = (VALID_EXCHANGES as readonly string[]).includes(requested ?? "")
      ? (requested as string)
      : (cfg.exchange || "mexc")
    const top = Math.min(12, Math.max(3, Number(params.get("top")) || 8))

    const raw = await fetchTickers(exchange)
    const bySymbol = new Map(raw.map((t) => [t.symbol.toUpperCase(), t]))
    const rows = raw.map(toUniverseRow)
    const shortlist = screenUniverse(rows, top)

    const client = getExchangeClient(exchange as Exchange)
    const inputs: Parameters<typeof rankTrendCandidates>[0] = []
    for (let i = 0; i < shortlist.length; i += CONCURRENCY) {
      const chunk = shortlist.slice(i, i + CONCURRENCY)
      const settled = await Promise.allSettled(
        chunk.map((symbol) => client.fetchKlines(symbol, "Min15", KLINES_LIMIT)),
      )
      settled.forEach((result, j) => {
        if (result.status !== "fulfilled" || result.value.length < 45) return
        const symbol = chunk[j]
        const t = bySymbol.get(symbol.toUpperCase())
        inputs.push({
          symbol,
          candles: result.value,
          lastPrice: t?.lastPrice ?? result.value[result.value.length - 1].close,
          turnover24h: t ? toUniverseRow(t).turnover24h : undefined,
          riseFallRate24h: t ? (t.riseFallRate24h ?? t.riseFallRate ?? 0) : 0,
          fundingRate: t?.fundingRate ?? 0,
        })
      })
    }

    const ranked = rankTrendCandidates(inputs)
    const winner = pickWinner(ranked)
    return NextResponse.json({
      exchange,
      scanned: ranked.length,
      shortlist,
      scores: ranked.map((s) => ({
        symbol: s.symbol,
        direction: s.direction,
        score: s.score,
        grade: s.grade,
        tradable: s.tradable,
        reasons: s.reasons.slice(0, 6),
        disqualified: s.disqualified ?? null,
      })),
      winner: winner
        ? {
            symbol: winner.symbol,
            direction: winner.direction,
            score: winner.score,
            grade: winner.grade,
            reasons: winner.reasons.slice(0, 6),
          }
        : null,
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Trend scan failed" },
      { status: 500 },
    )
  }
}

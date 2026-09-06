import { NextResponse } from "next/server"
import { getExchangeClient } from "@/lib/exchange"
import { detectSniper } from "@/lib/sniper"
import { computeSnapshot } from "@/lib/indicators"

const exchange = getExchangeClient("bybit")

export async function GET() {
  try {
    const tickers = await exchange.fetchAllTickers!()
    const ranked = tickers
      .filter((t) => (t.amount24 ?? 0) >= 1_000_000 && t.lastPrice >= 0.10)
      .map((t) => ({ ...t, score: Math.abs((t as any).riseFallRate ?? 0) * Math.log10((t.amount24 ?? 0) + 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)

    let sweepCount = 0
    let volPulse = 0
    let trendingUp = 0
    let trendingDown = 0
    const topCoins: any[] = []

    for (const t of ranked.slice(0, 20)) {
      try {
        const candles = await exchange.fetchKlines(t.symbol, "Min5", 60)
        if (candles.length < 50) continue

        const closes = candles.map((c) => c.close)
        const volumes = candles.map((c) => c.volume)
        const volNow = volumes[volumes.length - 1]
        const volAvg = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10

        if (volNow >= volAvg * 1.2) volPulse++

        const fastMean = closes.slice(-50).reduce((a, b) => a + b, 0) / 50
        const fastOlder = closes.slice(0, Math.max(0, closes.length - 50)).reduce((a, b) => a + b, 0) / Math.max(1, closes.length - 50)
        const trendUp = fastMean > fastOlder
        const trendDown = fastMean < fastOlder

        if (trendUp) trendingUp++
        if (trendDown) trendingDown++

        const snap = computeSnapshot(candles, { emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14 })
        const sig = detectSniper(candles, snap, 0.0001)
        if (sig?.direction) sweepCount++

        const last = candles[candles.length - 1]
        const prev = candles[candles.length - 2]
        const hasWick = last.low < prev.low || last.high > prev.high
        const potential = sig?.direction ? "hot" : hasWick && volNow >= volAvg * 1.1 ? "warm" : "cold"

        topCoins.push({
          symbol: t.symbol,
          trend: trendUp ? "up" : trendDown ? "down" : "neutral",
          volSurge: volAvg > 0 ? volNow / volAvg : 0,
          sweepPotential: potential,
          lastWick: hasWick ? 0 : Math.floor((Date.now() / 1000 - last.time) / 60),
        })
      } catch {
        // skip failed fetches
      }
    }

    topCoins.sort((a, b) => {
      const rank: Record<string, number> = { hot: 3, warm: 2, cold: 1 }
      return rank[b.sweepPotential] - rank[a.sweepPotential]
    })

    const sweepProb = Math.round((sweepCount / ranked.length) * 100)
    const volPulsePct = Math.round((volPulse / ranked.length) * 100)

    const forecast = [
      sweepProb,
      Math.max(0, sweepProb - 5 + Math.random() * 10),
      Math.max(0, sweepProb + (volPulsePct > 30 ? 15 : -5) + Math.random() * 10),
      Math.max(0, sweepProb + (volPulsePct > 30 ? 20 : 0) + Math.random() * 10),
      Math.max(0, sweepProb + (volPulsePct > 30 ? 15 : -5) + Math.random() * 10),
      Math.max(0, sweepProb - 10 + Math.random() * 10),
    ].map((v) => Math.min(100, Math.round(v)))

    const score = Math.min(100, Math.round(sweepProb * 0.6 + volPulsePct * 0.3 + (trendingUp + trendingDown) * 2))

    let label = "Poor — dead market"
    if (score >= 70) label = "Hot — sweeps likely"
    else if (score >= 50) label = "Good — conditions forming"
    else if (score >= 30) label = "Moderate — flat session"

    return NextResponse.json({
      score,
      label,
      sweepProb,
      volPulse: volPulsePct,
      trendingCount: trendingUp + trendingDown,
      topCoins: topCoins.slice(0, 5),
      forecast,
      lastUpdate: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

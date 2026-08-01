import type { ExchangeAdapter, Candle, Ticker, Market, OrderParams } from "./types"

const BASE = "https://api.bybit.com/v5"

export const bybitAdapter: ExchangeAdapter = {
  name: "bybit",
  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const map: Record<string, string> = { Min1: "1", Min5: "5", Min15: "15", Min30: "30", Min60: "60", Hour4: "240", Day1: "D" }
    const res = await fetch(`${BASE}/market/kline?category=linear&symbol=${symbol}&interval=${map[interval]||"5"}&limit=${limit}`)
    const json = await res.json()
    if (json.retCode !== 0) throw new Error(`Bybit: ${json.retMsg}`)
    return json.result.list.reverse().map((c: any) => ({
      time: Math.floor(Number(c[0])/1000), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5])
    }))
  },
  async fetchTicker(symbol: string): Promise<Ticker> {
    const res = await fetch(`${BASE}/market/tickers?category=linear&symbol=${symbol}`)
    const json = await res.json()
    const t = json.result.list[0]
    return { symbol: t.symbol, lastPrice: Number(t.lastPrice), fundingRate: Number(t.fundingRate||0), riseFallRate: Number(t.price24hPcnt||0), volume24: Number(t.volume24h||0) }
  },
  async fetchMarkets(): Promise<Market[]> {
    const res = await fetch(`${BASE}/market/instruments-info?category=linear&limit=1000`)
    const json = await res.json()
    return json.result.list.filter((m: any) => m.status === "Trading").map((m: any) => ({
      symbol: m.symbol, displayName: m.symbol, priceScale: 4, amountScale: 0, maxLeverage: Number(m.leverageFilter?.maxLeverage||100)
    }))
  },
  async placeOrder() { throw new Error("Bybit trading coming soon") },
  async getAccountAssets() { throw new Error("Bybit account coming soon") },
}

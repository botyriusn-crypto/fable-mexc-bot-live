import type { ExchangeAdapter, Candle, Ticker, Market, OrderParams } from "./types"

const BASE = "https://api.gateio.ws/api/v4"

export const gateAdapter: ExchangeAdapter = {
  name: "gate",
  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const map: Record<string, string> = { Min1: "1m", Min5: "5m", Min15: "15m", Min30: "30m", Min60: "1h", Hour4: "4h", Day1: "1d" }
    const gs = symbol.replace("_", "_")
    const res = await fetch(`${BASE}/futures/usdt/candlesticks?contract=${gs}&interval=${map[interval]||"5m"}&limit=${limit}`)
    const json = await res.json()
    return json.reverse().map((c: any) => ({
      time: Math.floor(Number(c.t)/1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v||0)
    }))
  },
  async fetchTicker(symbol: string): Promise<Ticker> {
    const gs = symbol.replace("_", "_")
    const res = await fetch(`${BASE}/futures/usdt/tickers?contract=${gs}`)
    const json = await res.json()
    const t = json[0]
    return { symbol: t.contract, lastPrice: Number(t.last), fundingRate: Number(t.funding_rate||0), riseFallRate: Number(t.change_percentage||0), volume24: Number(t.volume_24h||0) }
  },
  async fetchMarkets(): Promise<Market[]> {
    const res = await fetch(`${BASE}/futures/usdt/contracts`)
    const json = await res.json()
    return json.filter((m: any) => !m.in_delisting).map((m: any) => ({
      symbol: m.name.replace("_", "_"), displayName: m.name, priceScale: m.order_price_round||4, amountScale: 0, maxLeverage: Number(m.leverage_max||50)
    }))
  },
  async placeOrder() { throw new Error("Gate trading coming soon") },
  async getAccountAssets() { throw new Error("Gate account coming soon") },
}

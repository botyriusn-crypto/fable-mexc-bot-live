// MEXC Futures public market data client
const BASE_URL = "https://contract.mexc.com/api/v1/contract"

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface Ticker { symbol: string; lastPrice: number; fairPrice: number; fundingRate: number; riseFallRate: number; volume24: number }

export async function fetchKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000)
  const seconds = intervalToSeconds(interval)
  const start = end - seconds * limit
  const res = await fetch(`${BASE_URL}/kline/${symbol}?interval=${interval}&start=${start}&end=${end}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`MEXC kline fetch failed: ${res.status}`)
  const json = await res.json()
  if (!json.success || !json.data) throw new Error("MEXC kline response unsuccessful")
  const { time, open, high, low, close, vol } = json.data
  return time.map((_: number, i: number) => ({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] }))
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const res = await fetch(`${BASE_URL}/ticker?symbol=${symbol}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`MEXC ticker fetch failed: ${res.status}`)
  const json = await res.json()
  if (!json.success || !json.data) throw new Error("MEXC ticker response unsuccessful")
  const d = json.data
  return { symbol: d.symbol, lastPrice: d.lastPrice, fairPrice: d.fairPrice, fundingRate: d.fundingRate, riseFallRate: d.riseFallRate, volume24: d.volume24 }
}

export async function fetchMarkets() {
  const res = await fetch(`${BASE_URL}/detail`, { next: { revalidate: 300 } })
  if (!res.ok) throw new Error(`MEXC markets fetch failed: ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error("MEXC markets response unsuccessful")
  return json.data.filter((m: any) => m.state == null || m.state === 0).map((m: any) => ({
    symbol: m.symbol, displayName: m.displayName ?? m.symbol.replace("_", "/"),
    priceScale: m.priceScale ?? 4, amountScale: m.amountScale ?? 0, maxLeverage: m.maxLeverage ?? 20,
  }))
}

export function intervalToSeconds(interval: string): number {
  const m: Record<string, number> = { Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400 }
  return m[interval] ?? 300
}

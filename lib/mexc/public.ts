// MEXC Futures public market data client
const BASE_URL = "https://api.mexc.com/api/v1/contract"

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

// Global cache for MEXC contract precision scales
export const marketScales: Record<string, { price: number, amount: number }> = {}
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
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/ticker?symbol=${symbol}`, { cache: "no-store", headers })
      if (res.status === 429) {
        // Rate limited, wait 500ms and retry
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      if (!res.ok) throw new Error(`MEXC ticker fetch failed: ${res.status}`)
      
      const json = await res.json()
      if (!json.success || !json.data) {
        // MEXC sometimes returns 200 OK but with an error object if rate limited
        if (json.code === 429 || json.code === 411) {
          await new Promise(r => setTimeout(r, 500))
          continue
        }
        throw new Error("MEXC ticker response unsuccessful")
      }
      
      const d = json.data
      return { symbol: d.symbol, lastPrice: d.lastPrice, fairPrice: d.fairPrice, fundingRate: d.fundingRate, riseFallRate: d.riseFallRate, volume24: d.volume24 }
    } catch (err) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      throw err
    }
  }
  throw new Error("MEXC ticker failed after 3 retries")
}

let _marketsCache: { data: any; ts: number } | null = null
export async function fetchMarkets() {
  if (_marketsCache && Date.now() - _marketsCache.ts < 5 * 60 * 1000) return _marketsCache.data
  const res = await fetch(`${BASE_URL}/detail`, { cache: "no-store" })
  if (!res.ok) throw new Error(`MEXC markets fetch failed: ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error("MEXC markets response unsuccessful")
  
  const markets = json.data.filter((m: any) => m.state == null || m.state === 0).map((m: any) => {
    // Populate global cache for precision scaling
    marketScales[m.symbol] = { 
      price: m.priceScale ?? 4, 
      amount: m.amountScale ?? 0 
    }
    return {
      symbol: m.symbol, displayName: m.displayName ?? m.symbol.replace("_", "/"),
      priceScale: m.priceScale ?? 4, amountScale: m.amountScale ?? 0, maxLeverage: m.maxLeverage ?? 20,
    }
  })
  _marketsCache = { data: markets, ts: Date.now() }
  return markets
}

export function intervalToSeconds(interval: string): number {
  const m: Record<string, number> = { Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Hour8: 28800, Day1: 86400 }
  return m[interval] ?? 300
}

// Added for grid.ts and indicators.ts
export function getTicker(symbol: string): Promise<any> {
  return fetchTicker(symbol);
}

export function getCandles(symbol: string, timeframe: string, limit: number): Promise<any> {
  return fetchKlines(symbol, timeframe, limit);
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteAssetVolume?: number;
}

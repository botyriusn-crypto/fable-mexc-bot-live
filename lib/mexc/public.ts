// MEXC Futures public market data client
const BASE_URL = "https://api.mexc.com/api/v1/contract"

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

// Global cache for MEXC contract precision scales
export const marketScales: Record<string, { price: number, amount: number }> = {}
export interface Ticker { symbol: string; lastPrice: number; fairPrice: number; fundingRate: number; riseFallRate: number; volume24: number }

const __klineCache = new Map<string, { t: number; d: any }>()
async function __fetchKlinesRaw(symbol: string, interval: string, limit = 200): Promise<Candle[]>  {
  const end = Math.floor(Date.now() / 1000)
  const seconds = intervalToSeconds(interval)
  const start = end - seconds * limit
  const url = `${BASE_URL}/kline/${symbol}?interval=${interval}&start=${start}&end=${end}`
  console.log(`[MEXC] Fetching klines: ${url}`)
  
  try {
    const res = await fetch(url, { cache: "no-store" })
    if (!res) throw new Error("Null response from MEXC kline")
    if (!res.ok) throw new Error(`MEXC kline fetch failed: ${res.status}`)
    
    const json = await res.json()
    console.log(`[MEXC] Kline response: success=${json.success}, hasData=${!!json.data}, dataLength=${json.data?.time?.length || 0}`)
    
    if (!json.success || !json.data) {
      console.error(`[MEXC] Kline error response:`, JSON.stringify(json).substring(0, 200))
      throw new Error("MEXC kline response unsuccessful")
    }
    const { time, open, high, low, close, vol } = json.data
    return time.map((_: number, i: number) => ({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] }))
  } catch (err) {
    console.error(`[MEXC] Error fetching klines for ${symbol}:`, err)
    throw err
  }
}
export async function fetchKlines(symbol: string, interval: string, limit = 200) {
const key = String(symbol + "|" + interval + "|" + limit)
const now = Date.now()
const c = __klineCache.get(key)
if (c && now - c.t < 15000) return c.d
try {
const d = await __fetchKlinesRaw(symbol, interval, limit)
__klineCache.set(key, { t: Date.now(), d })
return d
} catch (e) {
if (c) return c.d
throw e
}
}

const __tickerCache = new Map<string, { t: number; d: any }>()
async function __fetchTickerRaw(symbol: string): Promise<Ticker>  {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/ticker?symbol=${symbol}`, { cache: "no-store", headers })
      if (!res) throw new Error("Null response from MEXC ticker")
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
export async function fetchTicker(symbol: string) {
const now = Date.now()
const c = __tickerCache.get(symbol)
if (c && now - c.t < 10000) return c.d
for (let attempt = 0; attempt < 2; attempt++) {
try {
const d = await __fetchTickerRaw(symbol)
__tickerCache.set(symbol, { t: Date.now(), d })
return d
} catch (e) {
if (attempt === 0) await new Promise(r => setTimeout(r, 400))
}
}
if (c) return c.d
throw new Error("MEXC ticker unavailable")
}

// Order-book depth: used to check whether a candidate market can actually
// absorb the position size a grid bot intends to place, without the bot's
// own order being a large fraction of what's resting at that price level.
// A coin can look perfectly calm on historical candles (low drift, decent
// ATR) and still be unsafe if the real book is thin — historical price
// shape alone can't detect this, only live depth can.
export interface DepthLevel { price: number; volume: number }
export interface MarketDepth { bids: DepthLevel[]; asks: DepthLevel[] }

export async function fetchDepth(symbol: string, limit = 20): Promise<MarketDepth> {
  const res = await fetch(`${BASE_URL}/depth/${symbol}?limit=${limit}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`MEXC depth fetch failed for ${symbol}: ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error(`MEXC depth response unsuccessful for ${symbol}`)
  const data = json.data ?? {}
  const toLevels = (raw: any[]): DepthLevel[] =>
    Array.isArray(raw) ? raw.map((r: any) => ({ price: Number(r[0]), volume: Number(r[1]) })) : []
  return { bids: toLevels(data.bids), asks: toLevels(data.asks) }
}

// Sums notional (price * volume) resting within `pctFromMid` of the current
// price on both sides — a rough proxy for how much size the market can
// absorb near where a grid order would actually sit.
export function depthNotionalNearMid(depth: MarketDepth, midPrice: number, pctFromMid = 0.02): number {
  const band = midPrice * pctFromMid
  const inBand = (levels: DepthLevel[]) =>
    levels.filter((l) => Math.abs(l.price - midPrice) <= band).reduce((sum, l) => sum + l.price * l.volume, 0)
  return inBand(depth.bids) + inBand(depth.asks)
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

// Bulk ticker for ALL USDT perpetuals in one call — used by the sniper to
// rank the whole market by volatility/momentum without N per-symbol calls.
export interface BulkTicker { symbol: string; lastPrice: number; volume24: number; riseFallRate: number; fundingRate: number }
let _bulkTickerCache: { data: BulkTicker[]; ts: number } | null = null

export async function fetchAllTickers(): Promise<BulkTicker[]> {
  if (_bulkTickerCache && Date.now() - _bulkTickerCache.ts < 30 * 1000) return _bulkTickerCache.data
  const res = await fetch(`${BASE_URL}/ticker`, { cache: "no-store" })
  if (!res.ok) throw new Error(`MEXC bulk ticker fetch failed: ${res.status}`)
  const json = await res.json()
  if (!json.success || !Array.isArray(json.data)) throw new Error("MEXC bulk ticker response unsuccessful")
  const data: BulkTicker[] = json.data
    .filter((t: any) => t.symbol.endsWith("_USDT"))
    .map((t: any) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      volume24: Number(t.volume24 ?? t.amount24 ?? 0),
      riseFallRate: Number(t.riseFallRate ?? 0),
      fundingRate: Number(t.fundingRate ?? 0),
    }))
  _bulkTickerCache = { data, ts: Date.now() }
  return data
}

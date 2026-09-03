// Bybit Futures public market data client (no API keys required)

const BASE_URL = "https://api.bybit.com/v5"

function toBybitSymbol(symbol: string): string {
  return symbol.replace(/_/g, "")  // BTC_USDT -> BTCUSDT
}

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
}

export interface Ticker {
  symbol: string; lastPrice: number; fundingRate: number; volume24: number
}

const HEADERS = { "Referer": "https://www.bybit.com" }

export async function fetchKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
  const bybitInterval = convertInterval(interval)
  const url = `${BASE_URL}/market/kline?category=linear&symbol=${toBybitSymbol(symbol)}&interval=${bybitInterval}&limit=${limit}`
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { cache: "no-store", headers: HEADERS })
    if (!res.ok) throw new Error(`Bybit kline fetch failed: ${res.status}`)
    const json = await res.json() as any
    // Bybit returns HTTP 200 with a non-zero retCode (and no result.list) on
    // rate-limit / transient errors. Retry rate-limits (10006) with backoff,
    // and surface the real reason for anything else instead of "invalid".
    if (json.retCode !== 0) {
      const retCode = json.retCode
      const retMsg = json.retMsg ?? "unknown"
      if (retCode === 10006 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
        continue
      }
      throw new Error(`Bybit kline error (${retCode}): ${retMsg}`)
    }
    if (!json.result?.list) throw new Error("Bybit kline response invalid")
    return json.result.list.map((c: any) => ({
      time: Math.floor(Number(c[0]) / 1000),
      open: Number(c[1]), high: Number(c[2]), low: Number(c[3]),
      close: Number(c[4]), volume: Number(c[5]),
    }))
  }
  throw new Error("Bybit kline fetch failed after retries")
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const url = `${BASE_URL}/market/tickers?category=linear&symbol=${toBybitSymbol(symbol)}`
  const res = await fetch(url, { cache: "no-store", headers: HEADERS })
  if (!res.ok) throw new Error(`Bybit ticker fetch failed: ${res.status}`)
  const json = await res.json() as any
  if (!json.result?.list?.length) throw new Error("Bybit ticker response invalid")
  const t = json.result.list[0]
  return {
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice),
    fundingRate: Number(t.fundingRate || 0),
    volume24: Number(t.turnover24h || 0),
  }
}

function convertInterval(interval: string): string {
  const map: Record<string, string> = {
    Min1: "1", Min5: "5", Min15: "15", Min30: "30",
    Min60: "60", Hour4: "240", Hour8: "480", Day1: "D",
  }
  return map[interval] ?? "5"
}

// Current funding rate for a linear symbol (decimal, e.g. 0.0001 = 0.01%).
export async function getFundingRate(symbol: string): Promise<number> {
  const url = `${BASE_URL}/market/tickers?category=linear&symbol=${toBybitSymbol(symbol)}`
  const res = await fetch(url, { cache: "no-store", headers: HEADERS })
  if (!res.ok) throw new Error(`Bybit funding fetch failed: ${res.status}`)
  const json = await res.json() as any
  const t = json.result?.list?.[0]
  if (!t) throw new Error("Bybit funding response invalid")
  return Number(t.fundingRate || 0)
}

// Recent funding history, oldest -> newest (decimal rates).
export async function getFundingHistory(symbol: string, limit = 20): Promise<number[]> {
  const url = `${BASE_URL}/market/funding/history?category=linear&symbol=${toBybitSymbol(symbol)}&limit=${limit}`
  const res = await fetch(url, { cache: "no-store", headers: HEADERS })
  if (!res.ok) throw new Error(`Bybit funding history fetch failed: ${res.status}`)
  const json = await res.json() as any
  const list = json.result?.list || []
  return list.map((e: any) => Number(e.fundingRate)).reverse()
}

// Fetch all USDT perpetual tickers from Bybit (for AI grid advisor scanning).
// Returns symbols in canonical format (BTC_USDT, not BTCUSDT).
export async function fetchAllTickers(): Promise<any[]> {
  const url = `${BASE_URL}/market/tickers?category=linear`
  const res = await fetch(url, { cache: "no-store", headers: HEADERS })
  if (!res.ok) throw new Error(`Bybit tickers fetch failed: ${res.status}`)
  const json = await res.json() as any
  if (json.retCode !== 0 || !json.result?.list) throw new Error(`Bybit tickers error: ${json.retMsg}`)
  
  const list = json.result.list as any[]
  const result: any[] = []
  for (const t of list) {
    if (typeof t.symbol !== "string" || !t.symbol.endsWith("USDT")) continue
    const sym = t.symbol as string
    const base = sym.slice(0, -4)
    const quote = sym.slice(-4)
    result.push({
      symbol: `${base}_${quote}`,
      lastPrice: Number(t.lastPrice ?? 0),
      fundingRate: Number(t.fundingRate ?? 0),
      volume24: Number(t.turnover24h ?? 0),
    })
  }
  return result
}

// Fetch all USDT perpetual tickers from Bybit (for AI grid advisor scanning).
// Returns symbols in canonical format (BTC_USDT, not BTCUSDT).


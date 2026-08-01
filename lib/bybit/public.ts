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
  const res = await fetch(url, { cache: "no-store", headers: HEADERS })
  if (!res.ok) throw new Error(`Bybit kline fetch failed: ${res.status}`)
  const json = await res.json() as any
  if (!json.result?.list) throw new Error("Bybit kline response invalid")
  return json.result.list.map((c: any) => ({
    time: Math.floor(Number(c[0]) / 1000),
    open: Number(c[1]), high: Number(c[2]), low: Number(c[3]),
    close: Number(c[4]), volume: Number(c[5]),
  }))
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

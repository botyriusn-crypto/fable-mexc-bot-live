// Gate.io Futures public market data client (no API keys required)

const BASE_URL = "https://api.gateio.ws/api/v4"

export interface Candle {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Ticker {
  symbol: string
  lastPrice: number
  fundingRate: number
  volume24: number
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 200,
): Promise<Candle[]> {
  // Gate.io interval format: 5m, 15m, 30m, 1h, 4h, 1d, etc.
  const gateInterval = convertInterval(interval)
  const res = await fetch(
    `${BASE_URL}/futures/usdt/candlesticks?contract=${symbol}&interval=${gateInterval}&limit=${limit}`,
    { cache: "no-store" },
  )
  if (!res.ok) {
    throw new Error(`Gate.io kline fetch failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as Array<[string, string, string, string, string, string]>
  if (!Array.isArray(data)) {
    throw new Error("Gate.io kline response invalid")
  }

  return data.map(([time, open, high, low, close, volume]) => ({
    time: Math.floor(Number(time) / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }))
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const res = await fetch(`${BASE_URL}/futures/usdt/tickers?contract=${symbol}`, {
    cache: "no-store",
  })
  if (!res.ok) {
    throw new Error(`Gate.io ticker fetch failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as Array<{
    contract: string
    last: string
    funding_rate: string
    volume_24h: string
  }>
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Gate.io ticker response invalid")
  }

  const ticker = data[0]
  return {
    symbol: ticker.contract,
    lastPrice: Number(ticker.last),
    fundingRate: Number(ticker.funding_rate),
    volume24: Number(ticker.volume_24h),
  }
}

function convertInterval(interval: string): string {
  const map: Record<string, string> = {
    Min1: "1m",
    Min5: "5m",
    Min15: "15m",
    Min30: "30m",
    Min60: "1h",
    Hour4: "4h",
    Hour8: "8h",
    Day1: "1d",
  }
  return map[interval] ?? "5m"
}

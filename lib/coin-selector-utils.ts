export interface CoinMarket {
  symbol: string
  displayName: string
  maxLeverage: number
  priceScale?: number
}

export const SUPPORTED_EXCHANGES = ["mexc", "gate", "bybit"] as const
export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number]

export const EXCHANGE_LABELS: Record<string, string> = {
  mexc: "MEXC",
  gate: "Gate.io",
  bybit: "Bybit",
}

export function normalizeExchange(value: unknown): SupportedExchange {
  const v = String(value ?? "mexc").toLowerCase()
  return (SUPPORTED_EXCHANGES as readonly string[]).includes(v)
    ? (v as SupportedExchange)
    : "mexc"
}

export function exchangeLabel(exchange: unknown): string {
  const key = normalizeExchange(exchange)
  return EXCHANGE_LABELS[key] ?? key.toUpperCase()
}

/** Exchange-aware SWR/fetcch URL. The exchange query param is the cache-buster. */
export function buildMarketUrl(exchange: unknown): string {
  return `/api/bot/market?exchange=${encodeURIComponent(normalizeExchange(exchange))}`
}

/**
 * Filter markets by free-text query (case-insensitive, matches symbol or
 * display name). Returns the COMPLETE list when the query is empty — callers
 * must not pre-truncate before calling this.
 */
export function filterMarkets(markets: CoinMarket[], query: string): CoinMarket[] {
  if (!Array.isArray(markets)) return []
  const q = (query ?? "").trim().toUpperCase()
  if (!q) return [...markets]
  return markets.filter(
    (m) =>
      (m.symbol ?? "").toUpperCase().includes(q) ||
      (m.displayName ?? "").toUpperCase().includes(q),
  )
}

/**
 * Remove already-added symbols (case-insensitive) so an "add" picker only
 * offers coins that are not on the list yet.
 */
export function excludeMarkets(markets: CoinMarket[], existingSymbols: string[]): CoinMarket[] {
  if (!Array.isArray(markets)) return []
  if (!Array.isArray(existingSymbols) || existingSymbols.length === 0) return [...markets]
  const existing = new Set(existingSymbols.map((s) => (s ?? "").toUpperCase()))
  return markets.filter((m) => !existing.has((m.symbol ?? "").toUpperCase()))
}

/**
 * Payload for adding a grid pair: the picker's coin plus the header's
 * "timeframe for NEW grids" selection. Symbol is normalized to uppercase to
 * match the market-list canonical form.
 */
export function buildAddPairPayload(symbol: string, timeframe: string): { symbol: string; timeframe: string } {
  return { symbol: (symbol ?? "").toUpperCase(), timeframe }
}

export function isSymbolAvailable(markets: CoinMarket[] | undefined, symbol: string): boolean {
  if (!Array.isArray(markets) || !symbol) return false
  const s = symbol.toUpperCase()
  return markets.some((m) => (m.symbol ?? "").toUpperCase() === s)
}

export function findMarket(
  markets: CoinMarket[] | undefined,
  symbol: string,
): CoinMarket | undefined {
  if (!Array.isArray(markets) || !symbol) return undefined
  const s = symbol.toUpperCase()
  return markets.find((m) => (m.symbol ?? "").toUpperCase() === s)
}

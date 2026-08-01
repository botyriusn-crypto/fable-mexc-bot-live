export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
}
export interface Ticker {
  symbol: string; lastPrice: number; fundingRate: number; riseFallRate: number; volume24: number
}
export interface Market {
  symbol: string; displayName: string; priceScale: number; amountScale: number; maxLeverage: number
}
export interface OrderParams {
  symbol: string; side: number; volume: number; leverage: number
}
export interface ExchangeAdapter {
  name: string
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]>
  fetchTicker(symbol: string): Promise<Ticker>
  fetchMarkets(): Promise<Market[]>
  placeOrder(params: OrderParams): Promise<void>
  getAccountAssets(): Promise<Array<{ currency: string; availableBalance: number; equity: number; unrealized: number; positionMargin: number }>>
}

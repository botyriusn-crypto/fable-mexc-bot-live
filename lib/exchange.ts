// Exchange adapter: routes public/private API calls to the correct exchange

import * as MexcPublic from "./mexc/public"
import * as MexcPrivate from "./mexc/private"
import * as GateioPublic from "./gateio/public"
import * as GateioPrivate from "./gateio/private"
import * as BybitPublic from "./bybit/public"
import * as BybitPrivate from "./bybit/private"

export type Exchange = "mexc" | "gate" | "bybit"

// Unified ticker type across all exchanges
export interface Ticker {
  symbol: string
  lastPrice: number
  fundingRate: number
  volume24: number
}

export type Candle = MexcPublic.Candle

export interface ExchangeClient {
  // Public (market data) API
  fetchKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>
  fetchTicker(symbol: string): Promise<Ticker>

  // Private (trading) API
  placeMarketOrder(opts: {
    symbol: string
    side: 1 | 2 | 3 | 4
    volume: number
    leverage: number
    price?: number
  }): Promise<unknown>
  getAccountAssets(): Promise<unknown>
  getOpenPositions(symbol?: string): Promise<unknown>
}

export function getExchangeClient(exchange: Exchange): ExchangeClient {
  switch (exchange) {
    case "gate":
      return {
        fetchKlines: GateioPublic.fetchKlines,
        fetchTicker: GateioPublic.fetchTicker,
        placeMarketOrder: GateioPrivate.placeMarketOrder,
        getAccountAssets: GateioPrivate.getAccountAssets,
        getOpenPositions: GateioPrivate.getOpenPositions,
      }
    case "bybit":
      return {
        fetchKlines: BybitPublic.fetchKlines,
        fetchTicker: BybitPublic.fetchTicker,
        placeMarketOrder: BybitPrivate.placeMarketOrder,
        getAccountAssets: BybitPrivate.getAccountAssets,
        getOpenPositions: BybitPrivate.getOpenPositions,
      }
    case "mexc":
    default:
      return {
        fetchKlines: MexcPublic.fetchKlines,
        fetchTicker: MexcPublic.fetchTicker,
        placeMarketOrder: MexcPrivate.placeMarketOrder,
        getAccountAssets: MexcPrivate.getAccountAssets,
        getOpenPositions: MexcPrivate.getOpenPositions,
      }
  }
}

import { getMexcFeeRates } from "./mexc/precision"
// Exchange adapter: routes public/private API calls to the correct exchange.
//
// This file is the single normalization boundary. Each venue's private module
// returns its own native shape; the mappers below translate native -> canonical
// so the harness (grid.ts, engine.ts) never has to know which venue it's on.

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

// ── Canonical, venue-agnostic shapes ──────────────────────────────
// The numeric `state` uses MEXC's numbering as the canonical contract:
// 1=unfilled, 2=partial, 3=filled, 4=cancelled, -1=unknown/error.

export interface AccountAsset {
  currency: string
  availableBalance: number
  equity: number
  unrealized: number
}

export interface OpenPosition {
  symbol: string        // canonical underscore format: BTC_USDT
  positionType: 1 | 2   // 1 = long, 2 = short
  holdVol: number       // contracts
  openAvgPrice: number
  leverage: number
}

export interface OrderStatus {
  state: number         // 1=unfilled, 2=partial, 3=filled, 4=cancelled, -1=unknown/error
  dealAvgPrice: number  // average fill price (0 if unfilled)
  isError: boolean
}

// ── MEXC mappers (already near-canonical; just coerce numbers) ────

function mapMexcAssets(raw: any): AccountAsset[] {
  if (!Array.isArray(raw)) return []
  return raw.map((a: any) => ({
    currency: String(a.currency ?? ""),
    availableBalance: Number(a.availableBalance ?? 0),
    equity: Number(a.equity ?? 0),
    unrealized: Number(a.unrealized ?? 0),
  }))
}

function mapMexcPositions(raw: any): OpenPosition[] {
  if (!Array.isArray(raw)) return []
  return raw.map((p: any) => ({
    symbol: String(p.symbol ?? ""),
    positionType: Number(p.positionType) === 2 ? 2 : 1,
    holdVol: Number(p.holdVol ?? 0),
    openAvgPrice: Number(p.openAvgPrice ?? 0),
    leverage: Number(p.leverage ?? 1),
  }))
}

function mapMexcOrderStatus(raw: any): OrderStatus {
  if (!raw || raw.isError) return { state: -1, dealAvgPrice: 0, isError: true }
  return {
    state: Number(raw.state ?? -1),
    dealAvgPrice: Number(raw.dealAvgPrice ?? 0),
    isError: false,
  }
}

// ── Bybit mappers ─────────────────────────────────────────────────

// Bybit /account/wallet-balance -> { list: [{ totalEquity, totalAvailableBalance, totalUnrealizedPnl, coin: [...] }] }
// NOTE: verify field names against a live/testnet response before relying on them.
function mapBybitAssets(raw: any): AccountAsset[] {
  const acct = raw?.list?.[0]
  if (!acct) return []
  return [{
    currency: "USDT",
    availableBalance: Number(acct.totalAvailableBalance ?? 0),
    equity: Number(acct.totalEquity ?? 0),
    unrealized: Number(acct.totalUnrealizedPnl ?? 0),
  }]
}

// BTCUSDT -> BTC_USDT (canonical underscore format)
function bybitSymbolToCanonical(s: string): string {
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}_USDT`
  return s
}

// Bybit /position/list -> { list: [{ symbol, side, size, avgPrice, leverage }] }
function mapBybitPositions(raw: any): OpenPosition[] {
  const list = raw?.list
  if (!Array.isArray(list)) return []
  return list.map((p: any) => ({
    symbol: bybitSymbolToCanonical(String(p.symbol ?? "")),
    positionType: p.side === "Sell" ? 2 : 1,
    holdVol: Number(p.size ?? 0),
    openAvgPrice: Number(p.avgPrice ?? 0),
    leverage: Number(p.leverage ?? 1),
  }))
}

// Bybit /order/realtime -> { list: [{ orderStatus, avgPrice }] }
function mapBybitOrderStatus(raw: any): OrderStatus {
  const o = raw?.list?.[0]
  if (!o) return { state: -1, dealAvgPrice: 0, isError: true }
  const stateMap: Record<string, number> = {
    New: 1, PartiallyFilled: 2, Filled: 3, Cancelled: 4, Rejected: 4,
    Untriggered: 1, Triggered: 1, Deactivated: 4,
  }
  return {
    state: stateMap[o.orderStatus] ?? -1,
    dealAvgPrice: Number(o.avgPrice ?? 0),
    isError: false,
  }
}

// ── Gate mappers ──────────────────────────────────────────────────

// Gate /futures/usdt/accounts -> single object { total, available, unrealised_pnl }
// NOTE: verify field names against a live/testnet response before relying on them.
function mapGateAssets(raw: any): AccountAsset[] {
  if (!raw || typeof raw !== "object") return []
  return [{
    currency: "USDT",
    availableBalance: Number(raw.available ?? 0),
    equity: Number(raw.total ?? 0),
    unrealized: Number(raw.unrealised_pnl ?? 0),
  }]
}

// Gate /futures/usdt/positions -> array of { contract, size, entry_price, leverage }
function mapGatePositions(raw: any): OpenPosition[] {
  if (!Array.isArray(raw)) return []
  return raw.map((p: any) => {
    const size = Number(p.size ?? 0)
    return {
      symbol: String(p.contract ?? ""),
      positionType: size < 0 ? 2 : 1,
      holdVol: Math.abs(size),
      openAvgPrice: Number(p.entry_price ?? 0),
      leverage: Number(p.leverage ?? 1),
    }
  })
}

// Gate /futures/usdt/orders/{id} -> { status, fill_price }
function mapGateOrderStatus(raw: any): OrderStatus {
  if (!raw || typeof raw !== "object") return { state: -1, dealAvgPrice: 0, isError: true }
  const stateMap: Record<string, number> = {
    open: 1, finished: 3, cancelled: 4,
  }
  return {
    state: stateMap[raw.status] ?? -1,
    dealAvgPrice: Number(raw.fill_price ?? 0),
    isError: false,
  }
}

// ── Client interface ──────────────────────────────────────────────

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
  placePostOnlyOrder(opts: {
    symbol: string
    side: 1 | 2 | 3 | 4
    price: number
    volume: number
    leverage: number
  }): Promise<unknown>
  fetchOrderStatus(orderId: string): Promise<OrderStatus>
  cancelOrders(orderIds: string[]): Promise<unknown>
  getAccountAssets(): Promise<AccountAsset[]>
  getOpenPositions(symbol?: string): Promise<OpenPosition[]>
}

export function getExchangeClient(exchange: Exchange): ExchangeClient {
  switch (exchange) {
    case "gate":
      return {
        fetchKlines: GateioPublic.fetchKlines,
        fetchTicker: GateioPublic.fetchTicker,
        placeMarketOrder: GateioPrivate.placeMarketOrder,
        placePostOnlyOrder: GateioPrivate.placePostOnlyOrder,
        fetchOrderStatus: async (id) => mapGateOrderStatus(await GateioPrivate.fetchOrderStatus(id)),
        cancelOrders: GateioPrivate.cancelOrders,
        getAccountAssets: async () => mapGateAssets(await GateioPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapGatePositions(await GateioPrivate.getOpenPositions(symbol)),
      }
    case "bybit":
      return {
        fetchKlines: BybitPublic.fetchKlines,
        fetchTicker: BybitPublic.fetchTicker,
        placeMarketOrder: BybitPrivate.placeMarketOrder,
        placePostOnlyOrder: BybitPrivate.placePostOnlyOrder,
        fetchOrderStatus: async (id) => mapBybitOrderStatus(await BybitPrivate.fetchOrderStatus(id)),
        cancelOrders: BybitPrivate.cancelOrders,
        getAccountAssets: async () => mapBybitAssets(await BybitPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapBybitPositions(await BybitPrivate.getOpenPositions(symbol)),
      }
    case "mexc":
    default:
      return {
        fetchKlines: MexcPublic.fetchKlines,
        fetchTicker: MexcPublic.fetchTicker,
        placeMarketOrder: MexcPrivate.placeMarketOrder,
        placePostOnlyOrder: MexcPrivate.placePostOnlyOrder,
        fetchOrderStatus: async (id) => mapMexcOrderStatus(await MexcPrivate.fetchOrderStatus(id)),
        cancelOrders: MexcPrivate.cancelOrders,
        getAccountAssets: async () => mapMexcAssets(await MexcPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapMexcPositions(await MexcPrivate.getOpenPositions(symbol)),
      }
  }
}


export function getFeeRates(exchange: Exchange, symbol: string): { makerFeeRate: number; takerFeeRate: number } {
  switch (exchange) {
    case "gate":
      // Gate.io USDT perpetual: maker rebate, taker 0.075%
      return { makerFeeRate: -0.0001, takerFeeRate: 0.00075 }
    case "bybit":
      // Bybit USDT perpetual non-VIP: maker 0.02%, taker 0.055%
      return { makerFeeRate: 0.0002, takerFeeRate: 0.00055 }
    case "mexc":
    default:
      return getMexcFeeRates(symbol)
  }
}

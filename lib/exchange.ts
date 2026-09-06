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
  amount24?: number
  riseFallRate?: number
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
  dealVol: number       // filled volume in the venue's native unit (0 if unfilled)
  isError: boolean
}

// Result of placing a market order AND confirming its fill by polling the
// order-status endpoint. `confirmed` is true only when the venue reported a
// real average fill price (> 0). When false, the caller MUST fall back to its
// intended price and treat the fill as unverified.
export interface ConfirmedFill {
  orderId: string       // venue order id ("" if it could not be extracted)
  avgPrice: number      // actual average fill price (0 if unconfirmed)
  filledVolume: number  // actual filled volume, venue-native unit (0 if unconfirmed)
  state: number         // canonical order state (see OrderStatus.state)
  confirmed: boolean    // true iff a real fill price was read back
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
  if (!raw || raw.isError) return { state: -1, dealAvgPrice: 0, dealVol: 0, isError: true }
  return {
    state: Number(raw.state ?? -1),
    dealAvgPrice: Number(raw.dealAvgPrice ?? 0),
    dealVol: Number(raw.dealVol ?? 0),
    isError: false,
  }
}

// MEXC /order/create returns the full envelope { success, code, data: <orderId> }.
function extractMexcOrderId(raw: any): string {
  const id = raw?.data
  return id == null ? "" : String(id)
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

// Bybit /order/realtime -> { list: [{ orderStatus, avgPrice, cumExecQty }] }
function mapBybitOrderStatus(raw: any): OrderStatus {
  const o = raw?.list?.[0]
  if (!o) return { state: -1, dealAvgPrice: 0, dealVol: 0, isError: true }
  const stateMap: Record<string, number> = {
    New: 1, PartiallyFilled: 2, Filled: 3, Cancelled: 4, Rejected: 4,
    Untriggered: 1, Triggered: 1, Deactivated: 4,
  }
  return {
    state: stateMap[o.orderStatus] ?? -1,
    dealAvgPrice: Number(o.avgPrice ?? 0),
    dealVol: Number(o.cumExecQty ?? 0),
    isError: false,
  }
}

// Bybit /order/create returns result -> { orderId, orderLinkId }.
function extractBybitOrderId(raw: any): string {
  const id = raw?.orderId
  return id == null ? "" : String(id)
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

// Gate /futures/usdt/orders/{id} -> { status, fill_price, size, left }
// Gate reports `size` (signed, requested) and `left` (signed, unfilled);
// filled = |size| - |left|.
function mapGateOrderStatus(raw: any): OrderStatus {
  if (!raw || typeof raw !== "object") return { state: -1, dealAvgPrice: 0, dealVol: 0, isError: true }
  const stateMap: Record<string, number> = {
    open: 1, finished: 3, cancelled: 4,
  }
  const size = Math.abs(Number(raw.size ?? 0))
  const left = Math.abs(Number(raw.left ?? 0))
  const filled = Math.max(0, size - left)
  return {
    state: stateMap[raw.status] ?? -1,
    dealAvgPrice: Number(raw.fill_price ?? 0),
    dealVol: filled,
    isError: false,
  }
}

// Gate /futures/usdt/orders returns the created order object -> { id, ... }.
function extractGateOrderId(raw: any): string {
  const id = raw?.id
  return id == null ? "" : String(id)
}

// ── Fill confirmation ─────────────────────────────────────────────
// After a market order is placed, poll the order-status endpoint until the
// venue reports a real average fill price. This turns a fire-and-forget order
// into a confirmed fill so the engine can persist ACTUAL price/qty instead of
// the intended price (which drifts from the real fill on market orders).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ConfirmOpts {
  placeRaw: unknown                                   // raw response from placeMarketOrder
  extractOrderId: (raw: any) => string                // venue order-id extractor
  fetchStatus: (orderId: string) => Promise<OrderStatus>
  attempts?: number                                   // poll attempts (default 6)
  delayMs?: number                                    // delay between polls (default 400ms)
}

export async function confirmFill(opts: ConfirmOpts): Promise<ConfirmedFill> {
  const { placeRaw, extractOrderId, fetchStatus } = opts
  const attempts = opts.attempts ?? 6
  const delayMs = opts.delayMs ?? 400

  const orderId = extractOrderId(placeRaw)
  const result: ConfirmedFill = { orderId, avgPrice: 0, filledVolume: 0, state: -1, confirmed: false }
  if (!orderId) return result // cannot confirm without an id — caller falls back

  for (let i = 0; i < attempts; i++) {
    let status: OrderStatus
    try {
      status = await fetchStatus(orderId)
    } catch {
      await sleep(delayMs)
      continue
    }
    result.state = status.state
    if (!status.isError && status.dealAvgPrice > 0) {
      result.avgPrice = status.dealAvgPrice
      result.filledVolume = status.dealVol
      // Fully filled (3) — done. Partially filled (2) — keep polling briefly to
      // catch the rest, but treat what we have as confirmed.
      result.confirmed = true
      if (status.state === 3) return result
    }
    // Cancelled/rejected with no fill — stop, nothing will fill.
    if (status.state === 4 && !result.confirmed) return result
    await sleep(delayMs)
  }
  return result
}

// ── Client interface ──────────────────────────────────────────────

export interface ExchangeClient {
  // Public (market data) API
  fetchKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>
  fetchTicker(symbol: string): Promise<Ticker>
  fetchAllTickers?(): Promise<Ticker[]>

  // Private (trading) API
  placeMarketOrder(opts: {
    symbol: string
    side: 1 | 2 | 3 | 4
    volume: number
    leverage: number
    price?: number
  }): Promise<unknown>
  // Place a market order AND confirm the actual fill (price + volume). Use this
  // for live execution so persisted price/qty reflect reality, not intent.
  placeMarketOrderConfirmed(opts: {
    symbol: string
    side: 1 | 2 | 3 | 4
    volume: number
    leverage: number
    price?: number
  }): Promise<ConfirmedFill>
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
    case "gate": {
      const gateStatus = async (id: string) => mapGateOrderStatus(await GateioPrivate.fetchOrderStatus(id))
      return {
        fetchKlines: GateioPublic.fetchKlines,
        fetchTicker: GateioPublic.fetchTicker,
        placeMarketOrder: GateioPrivate.placeMarketOrder,
        placeMarketOrderConfirmed: async (opts) =>
          confirmFill({
            placeRaw: await GateioPrivate.placeMarketOrder(opts),
            extractOrderId: extractGateOrderId,
            fetchStatus: gateStatus,
          }),
        placePostOnlyOrder: GateioPrivate.placePostOnlyOrder,
        fetchOrderStatus: gateStatus,
        cancelOrders: GateioPrivate.cancelOrders,
        getAccountAssets: async () => mapGateAssets(await GateioPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapGatePositions(await GateioPrivate.getOpenPositions(symbol)),
      }
    }
    case "bybit": {
      const bybitStatus = async (id: string) => mapBybitOrderStatus(await BybitPrivate.fetchOrderStatus(id))
      return {
        fetchKlines: BybitPublic.fetchKlines,
        fetchTicker: BybitPublic.fetchTicker,
        fetchAllTickers: BybitPublic.fetchAllTickers,
        placeMarketOrder: BybitPrivate.placeMarketOrder,
        placeMarketOrderConfirmed: async (opts) =>
          confirmFill({
            placeRaw: await BybitPrivate.placeMarketOrder(opts),
            extractOrderId: extractBybitOrderId,
            fetchStatus: bybitStatus,
          }),
        placePostOnlyOrder: BybitPrivate.placePostOnlyOrder,
        fetchOrderStatus: bybitStatus,
        cancelOrders: BybitPrivate.cancelOrders,
        getAccountAssets: async () => mapBybitAssets(await BybitPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapBybitPositions(await BybitPrivate.getOpenPositions(symbol)),
      }
    }
    case "mexc":
    default: {
      const mexcStatus = async (id: string) => mapMexcOrderStatus(await MexcPrivate.fetchOrderStatus(id))
      return {
        fetchKlines: MexcPublic.fetchKlines,
        fetchTicker: MexcPublic.fetchTicker,
        placeMarketOrder: MexcPrivate.placeMarketOrder,
        placeMarketOrderConfirmed: async (opts) =>
          confirmFill({
            placeRaw: await MexcPrivate.placeMarketOrder(opts),
            extractOrderId: extractMexcOrderId,
            fetchStatus: mexcStatus,
          }),
        placePostOnlyOrder: MexcPrivate.placePostOnlyOrder,
        fetchOrderStatus: mexcStatus,
        cancelOrders: MexcPrivate.cancelOrders,
        getAccountAssets: async () => mapMexcAssets(await MexcPrivate.getAccountAssets()),
        getOpenPositions: async (symbol) => mapMexcPositions(await MexcPrivate.getOpenPositions(symbol)),
      }
    }
  }
}


// Account-level fee-rate cache for Gate/Bybit. Warmed at module load so the
// synchronous getFeeRates() below can return real VIP-tier rates instead of
// the hardcoded default-tier assumptions. Falls back to defaults if the
// fetch fails (e.g. paper mode / no API keys configured).
const venueFeeCache: Record<string, { makerFeeRate: number; takerFeeRate: number }> = {}

async function warmVenueFees() {
  try {
    venueFeeCache["bybit"] = await BybitPrivate.getFeeRates()
  } catch (err) {
    console.warn("[Fees] Bybit fee-rate warmup failed:", err instanceof Error ? err.message : String(err))
  }
  try {
    venueFeeCache["gate"] = await GateioPrivate.getFeeRates()
  } catch (err) {
    console.warn("[Fees] Gate fee-rate warmup failed:", err instanceof Error ? err.message : String(err))
  }
}
warmVenueFees()

export function getFeeRates(exchange: Exchange, symbol: string): { makerFeeRate: number; takerFeeRate: number } {
  switch (exchange) {
    case "gate":
      // Gate.io USDT perpetual: maker rebate, taker 0.075% (default tier).
      // Real account rate wins once the warmup above completes.
      return venueFeeCache["gate"] ?? { makerFeeRate: -0.0001, takerFeeRate: 0.00075 }
    case "bybit":
      // Bybit USDT perpetual non-VIP: maker 0.02%, taker 0.055% (default tier).
      return venueFeeCache["bybit"] ?? { makerFeeRate: 0.0002, takerFeeRate: 0.00055 }
    case "mexc":
    default:
      return getMexcFeeRates(symbol)
  }
}

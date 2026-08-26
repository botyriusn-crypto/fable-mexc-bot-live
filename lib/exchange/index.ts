import type { ExchangeAdapter } from "./types"
import { bybitAdapter } from "./bybit"
import { gateAdapter } from "./gate"

const mexcAdapter: ExchangeAdapter = {
  name: "mexc",
  fetchKlines: async (s, i, l) => { const { fetchKlines } = await import("@/lib/mexc/public"); return fetchKlines(s, i, l) },
  fetchTicker: async (s) => { const { fetchTicker } = await import("@/lib/mexc/public"); return fetchTicker(s) },
  fetchMarkets: async () => { const { fetchMarkets } = await import("@/lib/mexc/public"); return fetchMarkets() },
  placeOrder: async (p) => { const { placeMarketOrder } = await import("@/lib/mexc/private"); await placeMarketOrder(p as any) },
  getAccountAssets: async () => { const { getAccountAssets } = await import("@/lib/mexc/private"); return getAccountAssets() },
}

const adapters: Record<string, ExchangeAdapter> = { mexc: mexcAdapter, bybit: bybitAdapter, gate: gateAdapter }

export function getExchange(name?: string): ExchangeAdapter {
  const exchange = name || process.env.EXCHANGE || "mexc"
  return adapters[exchange] || adapters.mexc
}

export function availableExchanges(): string[] { return Object.keys(adapters) }
export type { ExchangeAdapter }

// Gate.io Futures private (signed) API client — used only in live mode.

import crypto from "crypto"

const BASE_URL = "https://api.gateio.ws/api/v4"

function sign(method: string, path: string, body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const hashedPayload = crypto.createHash("sha512").update(body).digest("hex")
  const signStr = `${method}\n${path}\n${hashedPayload}\n${timestamp}`
  const signature = crypto.createHmac("sha512", secret).update(signStr).digest("hex")
  return signature
}

async function privateRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const apiKey = process.env.GATEIO_API_KEY
  const secret = process.env.GATEIO_API_SECRET
  if (!apiKey || !secret) {
    throw new Error("GATEIO_API_KEY / GATEIO_API_SECRET not configured")
  }

  const timestamp = Math.floor(Date.now() / 1000).toString()
  let url = `${BASE_URL}${path}`
  let body = ""

  if (method === "GET") {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&")
    if (qs) url += `?${qs}`
  } else {
    body = JSON.stringify(params)
  }

  const hashedPayload = crypto.createHash("sha512").update(body).digest("hex")
  const timestamp2 = Math.floor(Date.now() / 1000).toString()
  const signStr = `${method}\n${path}\n${hashedPayload}\n${timestamp2}`
  const signature = crypto.createHmac("sha512", secret).update(signStr).digest("hex")

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      KEY: apiKey,
      Timestamp: timestamp2,
      SIGN: signature,
    },
    body: method === "GET" ? undefined : body,
    cache: "no-store",
  })

  const json = (await res.json().catch(() => null)) as {
    label?: string
    message?: string
  } | null

  if (!res.ok) {
    throw new Error(
      `Gate.io private API error (${method} ${path}): ${res.status} ${json?.message ?? res.statusText}`,
    )
  }

  return json
}

// --- contract spec cache (quanto_multiplier, price round, min size) ---
interface GateSpec {
  quantoMultiplier: number
  orderPriceRound: number
  orderSizeMin: number
}

const gateSpecCache: Record<string, GateSpec> = {}

async function getGateSpec(symbol: string): Promise<GateSpec> {
  if (gateSpecCache[symbol]) return gateSpecCache[symbol]
  const res = await fetch(`${BASE_URL}/futures/usdt/contracts/${symbol}`, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`Gate.io contract detail fetch failed: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as {
    quanto_multiplier?: string
    order_price_round?: string
    order_size_min?: number
  }
  const spec: GateSpec = {
    quantoMultiplier: Number(data.quanto_multiplier ?? "1"),
    orderPriceRound: Number(data.order_price_round ?? "0.1"),
    orderSizeMin: Number(data.order_size_min ?? 1),
  }
  gateSpecCache[symbol] = spec
  return spec
}

// Convert coin quantity -> integer contracts (floored to quanto_multiplier),
// throwing if the result is below the symbol's minimum order size.
function roundGateQty(coinQty: number, spec: GateSpec): number {
  const contracts = Math.floor(coinQty / spec.quantoMultiplier)
  if (contracts < spec.orderSizeMin) {
    throw new Error(`Order size ${contracts} contracts below min ${spec.orderSizeMin} (${coinQty} coin, quanto ${spec.quantoMultiplier})`)
  }
  return contracts
}

// Round price to the symbol's order_price_round tick (nearest tick).
function roundGatePrice(price: number, spec: GateSpec): number {
  const decimals = (spec.orderPriceRound.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.round(price * factor) / factor
}

// --- account fee-rate cache (avoids a fetch per order) ---
let gateFeeRates: { makerFeeRate: number; takerFeeRate: number } | null = null

// Fetch the account's actual maker/taker fee rates (VIP-tier aware).
export async function getFeeRates(): Promise<{ makerFeeRate: number; takerFeeRate: number }> {
  if (gateFeeRates) return gateFeeRates
  const data = (await privateRequest("GET", "/futures/usdt/fee")) as {
    maker_fee?: string
    taker_fee?: string
  }
  gateFeeRates = {
    makerFeeRate: Number(data.maker_fee ?? "-0.0001"),
    takerFeeRate: Number(data.taker_fee ?? "0.00075"),
  }
  return gateFeeRates
}


// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io uses: long_open, long_close, short_open, short_close
export async function placeMarketOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  volume: number // coin quantity (base coin)
  leverage: number
}): Promise<unknown> {
  const sideMap: Record<number, string> = {
    1: "long_open",
    2: "long_close",
    3: "short_open",
    4: "short_close",
  }

  const spec = await getGateSpec(opts.symbol)
  const size = roundGateQty(opts.volume, spec)

  return privateRequest("POST", "/futures/usdt/orders", {
    contract: opts.symbol,
    size,
    price: "0", // market order
    tif: "ioc", // immediate or cancel
    reduce_only: opts.side === 2 || opts.side === 4,
  })
}

export async function getAccountAssets(): Promise<unknown> {
  return privateRequest("GET", "/futures/usdt/accounts")
}

export async function getOpenPositions(symbol?: string): Promise<unknown> {
  const path = symbol
    ? `/futures/usdt/positions?contract=${symbol}`
    : "/futures/usdt/positions"
  return privateRequest("GET", path)
}


// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io determines direction by the SIGN of `size` (positive = long,
// negative = short), combined with `reduce_only` for closes.
export async function placePostOnlyOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  price: number
  volume: number
  leverage: number
}): Promise<unknown> {
  const isClose = opts.side === 2 || opts.side === 4
  const isShort = opts.side === 3 || opts.side === 4
  const spec = await getGateSpec(opts.symbol)
  const size = roundGateQty(opts.volume, spec)
  const price = roundGatePrice(opts.price, spec)
  const signedSize = isShort ? -size : size
  return privateRequest("POST", "/futures/usdt/orders", {
    contract: opts.symbol,
    size: signedSize,
    price: String(price),
    tif: "poc", // post-only
    reduce_only: isClose,
  })
}

export async function fetchOrderStatus(orderId: string): Promise<unknown> {
  return privateRequest("GET", `/futures/usdt/orders/${orderId}`)
}

export async function cancelOrders(orderIds: string[]): Promise<unknown> {
  const results: unknown[] = []
  for (const orderId of orderIds) {
    results.push(await privateRequest("DELETE", `/futures/usdt/orders/${orderId}`))
  }
  return results
}

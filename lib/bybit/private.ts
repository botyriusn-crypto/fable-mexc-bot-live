// Bybit Futures private (signed) API client — used only in live mode.

import crypto from "crypto"

const BASE_URL = "https://api.bybit.com/v5"
const RECV_WINDOW = "5000"

function toBybitSymbol(symbol: string): string {
  return symbol.replace(/_/g, "") // BTC_USDT -> BTCUSDT
}

// Bybit v5 signature: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + paramString)
function sign(apiKey: string, secret: string, timestamp: string, paramString: string): string {
  const signStr = `${timestamp}${apiKey}${RECV_WINDOW}${paramString}`
  return crypto.createHmac("sha256", secret).update(signStr).digest("hex")
}

async function privateRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const apiKey = process.env.BYBIT_API_KEY
  const secret = process.env.BYBIT_API_SECRET
  if (!apiKey || !secret) {
    throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET not configured")
  }

  const timestamp = Date.now().toString()
  let url = `${BASE_URL}${path}`
  let body: string | undefined
  let paramString = ""

  if (method === "GET") {
    const qs = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&")
    paramString = qs
    if (qs) url += `?${qs}`
  } else {
    body = JSON.stringify(params)
    paramString = body
  }

  const signature = sign(apiKey, secret, timestamp, paramString)

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature,
    },
    body,
    cache: "no-store",
  })

  const json = (await res.json().catch(() => null)) as {
    retCode?: number
    retMsg?: string
    result?: unknown
  } | null

  if (!res.ok || json?.retCode !== 0) {
    throw new Error(
      `Bybit private API error (${method} ${path}): ${json?.retCode ?? res.status} ${json?.retMsg ?? res.statusText}`,
    )
  }

  return json?.result
}

// --- instrument qty-step cache (avoids a fetch per order) ---
const qtyStepCache: Record<string, number> = {}

async function getQtyStep(symbol: string): Promise<number> {
  const bs = toBybitSymbol(symbol)
  if (qtyStepCache[bs]) return qtyStepCache[bs]
  const r = (await privateRequest("GET", "/market/instruments-info", {
    category: "linear",
    symbol: bs,
  })) as { list?: Array<{ lotSizeFilter?: { qtyStep?: string } }> }
  const step = Number(r?.list?.[0]?.lotSizeFilter?.qtyStep ?? "0.001")
  qtyStepCache[bs] = step
  return step
}

// Round a contract quantity down to the symbol's qtyStep precision.
function roundQty(qty: number, step: number): number {
  const decimals = (step.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.floor(qty * factor) / factor
}

// Set leverage for a symbol (must be done before placing an order).
export async function setLeverage(symbol: string, leverage: number): Promise<unknown> {
  return privateRequest("POST", "/position/set-leverage", {
    category: "linear",
    symbol: toBybitSymbol(symbol),
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  })
}

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
export async function placeMarketOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  volume: number // contracts
  leverage: number
}): Promise<unknown> {
  const sideMap: Record<number, string> = {
    1: "Buy",   // open long
    2: "Sell",  // close short
    3: "Sell",  // open short
    4: "Buy",   // close long
  }

  const bs = toBybitSymbol(opts.symbol)
  const step = await getQtyStep(bs)
  const qty = roundQty(opts.volume, step)
  if (qty <= 0) throw new Error(`Order qty rounds to 0 (${opts.volume} contracts, step ${step})`)

  // Leverage must be set separately — Bybit rejects it on /order/create.
  await setLeverage(bs, opts.leverage)

  return privateRequest("POST", "/order/create", {
    category: "linear",
    symbol: bs,
    side: sideMap[opts.side],
    orderType: "Market",
    qty: String(qty),
    reduceOnly: opts.side === 2 || opts.side === 4,
  })
}

export async function getAccountAssets(): Promise<unknown> {
  return privateRequest("GET", "/account/wallet-balance", {
    accountType: "UNIFIED",
  })
}

export async function getOpenPositions(symbol?: string): Promise<unknown> {
  const params: Record<string, unknown> = {
    category: "linear",
    settleCoin: "USDT",
  }
  if (symbol) {
    params.symbol = toBybitSymbol(symbol)
  }
  return privateRequest("GET", "/position/list", params)
}

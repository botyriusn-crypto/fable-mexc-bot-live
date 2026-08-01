// Bybit Futures private (signed) API client — used only in live mode.

import crypto from "crypto"

const BASE_URL = "https://api.bybit.com/v5"

function sign(apiKey: string, secret: string, timestamp: string, paramString: string): string {
  const signStr = `${timestamp}${apiKey}${paramString}`
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
      "X-BAPI-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
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

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Bybit uses: Buy (for open long), Sell (for close short/open short/close long)
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

  return privateRequest("POST", "/order/create", {
    category: "linear",
    symbol: opts.symbol,
    side: sideMap[opts.side],
    orderType: "Market",
    qty: opts.volume,
    leverage: opts.leverage,
    reduce_only: opts.side === 2 || opts.side === 4 ? true : false,
  })
}

export async function getAccountAssets(): Promise<unknown> {
  return privateRequest("GET", "/account/wallet/balance", {
    accountType: "UNIFIED",
  })
}

export async function getOpenPositions(symbol?: string): Promise<unknown> {
  const params: Record<string, unknown> = {
    category: "linear",
    settleCoin: "USDT",
  }
  if (symbol) {
    params.symbol = symbol
  }
  return privateRequest("GET", "/position/list", params)
}

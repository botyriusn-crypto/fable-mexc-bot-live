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

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io uses: long_open, long_close, short_open, short_close
export async function placeMarketOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  volume: number // contracts
  leverage: number
}): Promise<unknown> {
  const sideMap: Record<number, string> = {
    1: "long_open",
    2: "long_close",
    3: "short_open",
    4: "short_close",
  }

  return privateRequest("POST", "/futures/usdt/orders", {
    contract: opts.symbol,
    size: opts.volume,
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

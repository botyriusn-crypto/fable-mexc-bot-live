import crypto from "crypto"
import { roundMexcQuantity, roundMexcPrice } from "./precision"

const BASE_URL = "https://contract.mexc.com/api/v1/private"

function sign(apiKey: string, secret: string, timestamp: string, paramString: string): string {
  const signStr = `${apiKey}${timestamp}${paramString}`
  return crypto.createHmac("sha256", secret).update(signStr).digest("hex")
}

async function privateRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const apiKey = process.env.MEXC_API_KEY
  const secret = process.env.MEXC_API_SECRET
  if (apiKey == null || secret == null) throw new Error("MEXC_API_KEY / MEXC_API_SECRET not configured")

  const timestamp = Date.now().toString()
  let url = `${BASE_URL}${path}`
  let body = ""
  let paramString = ""

  if (method === "GET") {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
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
      ApiKey: apiKey,
      "Request-Time": timestamp,
      Signature: signature,
    },
    body: method === "GET" ? undefined : body,
    cache: "no-store",
  })

  const json: any = await res.json().catch(() => null)

  const businessFailed =
    json?.success === false || (typeof json?.code === "number" && json.code !== 0)

  if (!res.ok || businessFailed) {
    throw new Error(
      `MEXC private API error (${path}): ${json?.code ?? res.status} ${json?.message ?? res.statusText}`,
    )
  }

  return json
}

async function setLeverage(symbol: string, leverage: number, positionType: 1 | 2): Promise<void> {
  try {
    await privateRequest("POST", "/position/change_leverage", {
      symbol,
      leverage,
      openType: 1,
      positionType,
    })
  } catch (err) {
    console.log(`setLeverage(${symbol}, ${leverage}, pt=${positionType}) skipped:`, String(err))
  }
}

export async function placeMarketOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  volume: number
  leverage: number
  price?: number
}): Promise<unknown> {
  const vol = roundMexcQuantity(opts.symbol, opts.price ?? 0, opts.volume)

  if (opts.side === 1 || opts.side === 3) {
    const positionType: 1 | 2 = opts.side === 1 ? 1 : 2
    await setLeverage(opts.symbol, opts.leverage, positionType)
  }

  return privateRequest("POST", "/order/create", {
    symbol: opts.symbol,
    side: opts.side,
    vol,
    leverage: opts.leverage,
    type: 5,
    openType: 1,
  })
}

export async function getAccountAssets(): Promise<unknown> {
  const result: any = await privateRequest("GET", "/account/assets")
  if (result && typeof result === "object" && "data" in result) {
    return result.data
  }
  return result
}

export async function getOpenPositions(symbol?: string): Promise<unknown> {
  const path = symbol ? `/position/open?symbol=${symbol}` : "/position/open"
  return privateRequest("GET", path)
}

export async function fetchOrderStatus(orderId: string): Promise<any | null> {
  try {
    const res: any = await privateRequest("GET", `/order/get/${orderId}`)
    return res?.data ?? null
  } catch (err) {
    console.log(`fetchOrderStatus(${orderId}) failed:`, String(err))
    return null
  }
}

export async function fetchOpenOrders(symbol: string): Promise<any[]> {
  try {
    const res: any = await privateRequest("GET", `/order/list/open_orders/${symbol}`)
    const data = res?.data
    return Array.isArray(data) ? data : []
  } catch (err) {
    console.log(`fetchOpenOrders(${symbol}) failed:`, String(err))
    return []
  }
}

export async function placePostOnlyOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  price: number
  volume: number
  leverage: number
}): Promise<any> {
  const vol = roundMexcQuantity(opts.symbol, opts.price, opts.volume)
  const price = roundMexcPrice(opts.symbol, opts.price)
  if (opts.side === 1 || opts.side === 3) {
    const positionType: 1 | 2 = opts.side === 1 ? 1 : 2
    await setLeverage(opts.symbol, opts.leverage, positionType)
  }
  return privateRequest("POST", "/order/create", {
    symbol: opts.symbol,
    side: opts.side,
    vol,
    price,
    leverage: opts.leverage,
    type: 2,
    openType: 1,
  })
}

export async function cancelOrders(orderIds: string[]): Promise<any> {
  const apiKey = process.env.MEXC_API_KEY
  const secret = process.env.MEXC_API_SECRET
  if (apiKey == null || secret == null) throw new Error("MEXC keys not configured")
  const timestamp = Date.now().toString()
  const body = JSON.stringify(orderIds)
  const signature = sign(apiKey, secret, timestamp, body)
  const res = await fetch(`${BASE_URL}/order/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ApiKey: apiKey,
      "Request-Time": timestamp,
      Signature: signature,
    },
    body,
    cache: "no-store",
  })
  return res.json().catch(() => null)
}

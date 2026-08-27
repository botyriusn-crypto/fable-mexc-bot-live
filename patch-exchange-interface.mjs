import fs from "fs"

// ---- 1. lib/exchange.ts: expand the ExchangeClient interface ----
let ex = fs.readFileSync("lib/exchange.ts", "utf8")

const ifaceAnchor = `  getAccountAssets(): Promise<unknown>
  getOpenPositions(symbol?: string): Promise<unknown>
}`
const ifaceNew = `  placePostOnlyOrder(opts: {
    symbol: string
    side: 1 | 2 | 3 | 4
    price: number
    volume: number
    leverage: number
  }): Promise<unknown>
  fetchOrderStatus(orderId: string): Promise<unknown>
  cancelOrders(orderIds: string[]): Promise<unknown>
  getAccountAssets(): Promise<unknown>
  getOpenPositions(symbol?: string): Promise<unknown>
}`
if (!ex.includes(ifaceAnchor)) { console.error("interface anchor not found"); process.exit(1) }
ex = ex.replace(ifaceAnchor, ifaceNew)

const gateAnchor = `        placeMarketOrder: GateioPrivate.placeMarketOrder,
        getAccountAssets: GateioPrivate.getAccountAssets,`
const gateNew = `        placeMarketOrder: GateioPrivate.placeMarketOrder,
        placePostOnlyOrder: GateioPrivate.placePostOnlyOrder,
        fetchOrderStatus: GateioPrivate.fetchOrderStatus,
        cancelOrders: GateioPrivate.cancelOrders,
        getAccountAssets: GateioPrivate.getAccountAssets,`
if (!ex.includes(gateAnchor)) { console.error("gate anchor not found"); process.exit(1) }
ex = ex.replace(gateAnchor, gateNew)

const bybitAnchor = `        placeMarketOrder: BybitPrivate.placeMarketOrder,
        getAccountAssets: BybitPrivate.getAccountAssets,`
const bybitNew = `        placeMarketOrder: BybitPrivate.placeMarketOrder,
        placePostOnlyOrder: BybitPrivate.placePostOnlyOrder,
        fetchOrderStatus: BybitPrivate.fetchOrderStatus,
        cancelOrders: BybitPrivate.cancelOrders,
        getAccountAssets: BybitPrivate.getAccountAssets,`
if (!ex.includes(bybitAnchor)) { console.error("bybit anchor not found"); process.exit(1) }
ex = ex.replace(bybitAnchor, bybitNew)

const mexcAnchor = `        placeMarketOrder: MexcPrivate.placeMarketOrder,
        getAccountAssets: MexcPrivate.getAccountAssets,`
const mexcNew = `        placeMarketOrder: MexcPrivate.placeMarketOrder,
        placePostOnlyOrder: MexcPrivate.placePostOnlyOrder,
        fetchOrderStatus: MexcPrivate.fetchOrderStatus,
        cancelOrders: MexcPrivate.cancelOrders,
        getAccountAssets: MexcPrivate.getAccountAssets,`
if (!ex.includes(mexcAnchor)) { console.error("mexc anchor not found"); process.exit(1) }
ex = ex.replace(mexcAnchor, mexcNew)

fs.writeFileSync("lib/exchange.ts", ex)
console.log("patched lib/exchange.ts")

// ---- 2. lib/bybit/private.ts: append missing methods ----
const bybitNewMethods = `

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
export async function placePostOnlyOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  price: number
  volume: number
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
  if (qty <= 0) throw new Error(\`Order qty rounds to 0 (\${opts.volume} contracts, step \${step})\`)
  await setLeverage(bs, opts.leverage)
  return privateRequest("POST", "/order/create", {
    category: "linear",
    symbol: bs,
    side: sideMap[opts.side],
    orderType: "Limit",
    price: String(opts.price),
    qty: String(qty),
    timeInForce: "PostOnly",
    reduceOnly: opts.side === 2 || opts.side === 4,
  })
}

export async function fetchOrderStatus(orderId: string): Promise<unknown> {
  return privateRequest("GET", "/order/realtime", {
    category: "linear",
    orderId,
  })
}

export async function cancelOrders(orderIds: string[]): Promise<unknown> {
  const results: unknown[] = []
  for (const orderId of orderIds) {
    results.push(
      await privateRequest("POST", "/order/cancel", {
        category: "linear",
        orderId,
      })
    )
  }
  return results
}
`
fs.appendFileSync("lib/bybit/private.ts", bybitNewMethods)
console.log("patched lib/bybit/private.ts")

// ---- 3. lib/gateio/private.ts: append missing methods ----
const gateNewMethods = `

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io determines direction by the SIGN of \`size\` (positive = long,
// negative = short), combined with \`reduce_only\` for closes.
export async function placePostOnlyOrder(opts: {
  symbol: string
  side: 1 | 2 | 3 | 4
  price: number
  volume: number
  leverage: number
}): Promise<unknown> {
  const isClose = opts.side === 2 || opts.side === 4
  const isShort = opts.side === 3 || opts.side === 4
  const signedSize = isShort ? -opts.volume : opts.volume
  return privateRequest("POST", "/futures/usdt/orders", {
    contract: opts.symbol,
    size: signedSize,
    price: String(opts.price),
    tif: "poc", // post-only
    reduce_only: isClose,
  })
}

export async function fetchOrderStatus(orderId: string): Promise<unknown> {
  return privateRequest("GET", \`/futures/usdt/orders/\${orderId}\`)
}

export async function cancelOrders(orderIds: string[]): Promise<unknown> {
  const results: unknown[] = []
  for (const orderId of orderIds) {
    results.push(await privateRequest("DELETE", \`/futures/usdt/orders/\${orderId}\`))
  }
  return results
}
`
fs.appendFileSync("lib/gateio/private.ts", gateNewMethods)
console.log("patched lib/gateio/private.ts")

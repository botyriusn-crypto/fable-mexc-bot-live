import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"

const log = []
function patch(file, pairs) {
  let src = readFileSync(file, "utf8")
  for (const [oldStr, newStr, expected] of pairs) {
    const count = src.split(oldStr).length - 1
    if (count === 0) {
      log.push(`MISS  ${file}: ${oldStr.slice(0, 60).replace(/\n/g, "\\n")}`)
      continue
    }
    src = src.split(oldStr).join(newStr)
    log.push(`${count === expected ? "ok   " : "COUNT"} (${count}/${expected}) ${file}: ${oldStr.slice(0, 50).replace(/\n/g, "\\n")}`)
  }
  writeFileSync(file, src)
}

// ────────────────────────────────────────────────────────────────
// 3a — grid.ts: remove harness pre-rounding
// ────────────────────────────────────────────────────────────────
patch("lib/grid.ts", [
  // 1. trim import: drop roundMexcQuantity/roundMexcPrice/getMexcSpec (all now dead)
  [
    `import { roundMexcQuantity, roundMexcPrice, getMexcSpec, getMexcSpecAsync, getMexcFeeRates } from "./mexc/precision"`,
    `import { getMexcSpecAsync, getMexcFeeRates } from "./mexc/precision"`,
    1,
  ],
  // 2. delete roundForMexc entirely
  [
    `function roundForMexc(symbol: string, price: number, quantity: number): { price: number, quantity: number } {
  // Use safe synchronous specs to avoid initialization errors
  const spec = getMexcSpec(symbol, price)
  const roundedPrice = Number((Math.round(price / spec.priceUnit) * spec.priceUnit).toFixed(spec.priceScale))
  const roundedQty = Math.max(spec.minVol, Math.round(quantity / spec.contractSize) * spec.contractSize)
  return {
    price: roundedPrice,
    quantity: roundedQty
  }
}`,
    ``,
    1,
  ],
  // 3. placeRoundedMakerOrder: pass raw price/volume
  [
    `  const rounded = roundForMexc(symbol, price, volume)
  return exchange.placePostOnlyOrder({
    symbol,
    side: side as 1 | 2 | 3 | 4,
    price: rounded.price,
    volume: rounded.quantity,
    leverage,
  })`,
    `  return exchange.placePostOnlyOrder({
    symbol,
    side: side as 1 | 2 | 3 | 4,
    price,
    volume,
    leverage,
  })`,
    1,
  ],
  // 4. line 701 market-order close: drop roundForMexc
  [
    `      if (exchange) { const r = roundForMexc(order.symbol, order.price, order.quantity); await exchange.placeMarketOrder({ symbol: order.symbol, side: 4, volume: r.quantity, leverage: order.leverage }) }`,
    `      if (exchange) { await exchange.placeMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage }) }`,
    1,
  ],
  // 5. line 1518 market-order buy: drop roundForMexc
  [
    `          if (exchange) { const r = roundForMexc(o.symbol, o.price, o.quantity); await log("info", \`LIVE buy: \${o.symbol} price=\${r.price} qty=\${r.quantity} lev=\${o.leverage}\`); await exchange.placeMarketOrder({ symbol: o.symbol, side: 1 as any, volume: r.quantity, leverage: o.leverage }) }`,
    `          if (exchange) { await log("info", \`LIVE buy: \${o.symbol} price=\${o.price} qty=\${o.quantity} lev=\${o.leverage}\`); await exchange.placeMarketOrder({ symbol: o.symbol, side: 1 as any, volume: o.quantity, leverage: o.leverage }) }`,
    1,
  ],
])

// ────────────────────────────────────────────────────────────────
// 3b — bybit/private.ts: add price rounding to placePostOnlyOrder
// ────────────────────────────────────────────────────────────────
patch("lib/bybit/private.ts", [
  // add getTickSize + roundPrice after roundQty
  [
    `// Round a contract quantity down to the symbol's qtyStep precision.
function roundQty(qty: number, step: number): number {
  const decimals = (step.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.floor(qty * factor) / factor
}`,
    `// Round a contract quantity down to the symbol's qtyStep precision.
function roundQty(qty: number, step: number): number {
  const decimals = (step.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.floor(qty * factor) / factor
}

// --- instrument tick-size cache (avoids a fetch per order) ---
const tickSizeCache: Record<string, number> = {}

async function getTickSize(symbol: string): Promise<number> {
  const bs = toBybitSymbol(symbol)
  if (tickSizeCache[bs]) return tickSizeCache[bs]
  const r = (await privateRequest("GET", "/market/instruments-info", {
    category: "linear",
    symbol: bs,
  })) as { list?: Array<{ priceFilter?: { tickSize?: string } }> }
  const tick = Number(r?.list?.[0]?.priceFilter?.tickSize ?? "0.1")
  tickSizeCache[bs] = tick
  return tick
}

// Round a price to the symbol's tickSize precision (nearest tick).
function roundPrice(price: number, tick: number): number {
  const decimals = (tick.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.round(price * factor) / factor
}`,
    1,
  ],
  // wire price rounding into placePostOnlyOrder
  [
    `  const bs = toBybitSymbol(opts.symbol)
  const step = await getQtyStep(bs)
  const qty = roundQty(opts.volume, step)
  if (qty <= 0) throw new Error(\`Order qty rounds to 0 (\${opts.volume} contracts, step \${step})\`)
  await setLeverage(bs, opts.leverage)
  return privateRequest("POST", "/order/create", {
    category: "linear",
    symbol: bs,
    side: sideMap[opts.side],
    orderType: "Limit",
    price: String(opts.price),`,
    `  const bs = toBybitSymbol(opts.symbol)
  const step = await getQtyStep(bs)
  const qty = roundQty(opts.volume, step)
  if (qty <= 0) throw new Error(\`Order qty rounds to 0 (\${opts.volume} contracts, step \${step})\`)
  const tick = await getTickSize(bs)
  const price = roundPrice(opts.price, tick)
  await setLeverage(bs, opts.leverage)
  return privateRequest("POST", "/order/create", {
    category: "linear",
    symbol: bs,
    side: sideMap[opts.side],
    orderType: "Limit",
    price: String(price),`,
    1,
  ],
])

// ────────────────────────────────────────────────────────────────
// 3b — gateio/private.ts: add spec fetch + coin→contracts + rounding
// ────────────────────────────────────────────────────────────────
patch("lib/gateio/private.ts", [
  // insert spec helpers before placeMarketOrder
  [
    `// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io uses: long_open, long_close, short_open, short_close
export async function placeMarketOrder(opts: {`,
    `// --- contract spec cache (quanto_multiplier, price round, min size) ---
interface GateSpec {
  quantoMultiplier: number
  orderPriceRound: number
  orderSizeMin: number
}

const gateSpecCache: Record<string, GateSpec> = {}

async function getGateSpec(symbol: string): Promise<GateSpec> {
  if (gateSpecCache[symbol]) return gateSpecCache[symbol]
  const res = await fetch(\`\${BASE_URL}/futures/usdt/contracts/\${symbol}\`, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(\`Gate.io contract detail fetch failed: \${res.status} \${res.statusText}\`)
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
    throw new Error(\`Order size \${contracts} contracts below min \${spec.orderSizeMin} (\${coinQty} coin, quanto \${spec.quantoMultiplier})\`)
  }
  return contracts
}

// Round price to the symbol's order_price_round tick (nearest tick).
function roundGatePrice(price: number, spec: GateSpec): number {
  const decimals = (spec.orderPriceRound.toString().split(".")[1] || "").length
  const factor = Math.pow(10, decimals)
  return Math.round(price * factor) / factor
}

// side: 1 = open long, 2 = close short, 3 = open short, 4 = close long
// Gate.io uses: long_open, long_close, short_open, short_close
export async function placeMarketOrder(opts: {`,
    1,
  ],
  // placeMarketOrder: convert + round qty
  [
    `  volume: number // contracts
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
}`,
    `  volume: number // coin quantity (base coin)
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
}`,
    1,
  ],
  // placePostOnlyOrder: convert + round qty + round price
  [
    `  const isClose = opts.side === 2 || opts.side === 4
  const isShort = opts.side === 3 || opts.side === 4
  const signedSize = isShort ? -opts.volume : opts.volume
  return privateRequest("POST", "/futures/usdt/orders", {
    contract: opts.symbol,
    size: signedSize,
    price: String(opts.price),
    tif: "poc", // post-only
    reduce_only: isClose,
  })`,
    `  const isClose = opts.side === 2 || opts.side === 4
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
  })`,
    1,
  ],
])

// ────────────────────────────────────────────────────────────────
// cleanup: delete stale files
// ────────────────────────────────────────────────────────────────
for (const f of ["lib/grid.ts.broken", "lib/mexc/precision.ts.bak2"]) {
  if (existsSync(f)) { unlinkSync(f); log.push(`ok   deleted ${f}`) }
  else { log.push(`skip ${f} (not found)`) }
}

console.log(log.join("\n"))
console.log("\ndone")

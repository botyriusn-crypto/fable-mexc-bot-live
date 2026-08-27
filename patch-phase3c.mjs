import { readFileSync, writeFileSync } from "fs"

// ---- 1. lib/exchange.ts: add getMexcFeeRates import + getFeeRates dispatcher ----
let ex = readFileSync("lib/exchange.ts", "utf8")

if (!ex.includes("getMexcFeeRates")) {
  ex = `import { getMexcFeeRates } from "./mexc/precision"\n` + ex
  console.log("ok  lib/exchange.ts: added getMexcFeeRates import")
} else {
  console.log("skip lib/exchange.ts: import already present")
}

if (!ex.includes("export function getFeeRates")) {
  ex += `

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
`
  console.log("ok  lib/exchange.ts: added getFeeRates")
} else {
  console.log("skip lib/exchange.ts: getFeeRates already present")
}

writeFileSync("lib/exchange.ts", ex)

// ---- 2. lib/grid.ts: import swap + 14 call-site rewrite ----
let g = readFileSync("lib/grid.ts", "utf8")

const imp11 = `import { getMexcSpecAsync, getMexcFeeRates } from "./mexc/precision"`
const imp11new = `import { getMexcSpecAsync } from "./mexc/precision"`
if (g.includes(imp11)) {
  g = g.replace(imp11, imp11new)
  console.log("ok  lib/grid.ts: import line 11 (drop getMexcFeeRates)")
} else {
  console.log("MISS lib/grid.ts: import line 11")
}

const imp8 = `import { getExchangeClient, type ExchangeClient, type Exchange } from "./exchange"`
const imp8new = `import { getExchangeClient, getFeeRates, type ExchangeClient, type Exchange } from "./exchange"`
if (g.includes(imp8)) {
  g = g.replace(imp8, imp8new)
  console.log("ok  lib/grid.ts: import line 8 (add getFeeRates)")
} else {
  console.log("MISS lib/grid.ts: import line 8")
}

const before = (g.match(/getMexcFeeRates\(/g) || []).length
g = g.replace(/getMexcFeeRates\(/g, "getFeeRates(cfg.exchange as Exchange, ")
const after = (g.match(/getFeeRates\(cfg\.exchange as Exchange, /g) || []).length
console.log(`ok  lib/grid.ts: rewrote ${before} -> ${after} call sites`)

writeFileSync("lib/grid.ts", g)

// ---- 3. verify ----
const leftover = (g.match(/getMexcFeeRates/g) || []).length
console.log(`verify: leftover getMexcFeeRates in grid.ts = ${leftover} (expect 0)`)

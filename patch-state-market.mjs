import { readFileSync, writeFileSync } from "fs"

const f = "app/api/bot/state/route.ts"
let s = readFileSync(f, "utf8")

// 1. Drop the hardcoded MEXC public import (getExchangeClient already imported on next line)
const impOld = `import { fetchTicker, fetchKlines } from "@/lib/mexc/public"\n`
if (s.includes(impOld)) {
  s = s.replace(impOld, "")
  console.log("ok  removed mexc/public import")
} else {
  console.log("MISS mexc/public import")
}

// 2. Regime detection: ticker + candles via venue client
const regimeOld = `const [t, candles] = await Promise.all([fetchTicker(cfg.symbol), fetchKlines(cfg.symbol, cfg.timeframe, 200)])`
const regimeNew = `const ex = getExchangeClient(cfg.exchange as Exchange)
      const [t, candles] = await Promise.all([ex.fetchTicker(cfg.symbol), ex.fetchKlines(cfg.symbol, cfg.timeframe, 200)])`
if (s.includes(regimeOld)) {
  s = s.replace(regimeOld, regimeNew)
  console.log("ok  regime ticker/candles -> venue client")
} else {
  console.log("MISS regime call site")
}

// 3. Exposure tickers via venue client
const expOld = `try { return [s, (await fetchTicker(s)).lastPrice] as const }`
const expNew = `try { return [s, (await getExchangeClient(cfg.exchange as Exchange).fetchTicker(s)).lastPrice] as const }`
if (s.includes(expOld)) {
  s = s.replace(expOld, expNew)
  console.log("ok  exposure ticker -> venue client")
} else {
  console.log("MISS exposure call site")
}

writeFileSync(f, s)
console.log("done")

import { readFileSync, writeFileSync } from "fs"

const f = "app/api/bot/state/route.ts"
let s = readFileSync(f, "utf8")

// 1. Swap hardcoded MEXC import for the venue-agnostic client
const impOld = `import { getAccountAssets } from "@/lib/mexc/private"`
const impNew = `import { getExchangeClient, type Exchange } from "@/lib/exchange"`
if (s.includes(impOld)) {
  s = s.replace(impOld, impNew)
  console.log("ok  import: getAccountAssets -> getExchangeClient")
} else {
  console.log("MISS import line")
}

// 2. Rename interface + make positionMargin/frozenBalance optional (Bybit omits them)
const ifaceOld = `interface MexcAsset {
  currency: string; availableBalance: number; equity: number;
  unrealized: number; positionMargin: number; frozenBalance: number;
}`
const ifaceNew = `interface AccountAsset {
  currency: string; availableBalance: number; equity: number;
  unrealized: number; positionMargin?: number; frozenBalance?: number;
}`
if (s.includes(ifaceOld)) {
  s = s.replace(ifaceOld, ifaceNew)
  console.log("ok  interface MexcAsset -> AccountAsset")
} else {
  console.log("MISS interface")
}

// 3. Rewrite fetchLiveAccount to route by venue
const fnOld = `async function fetchLiveAccount() {
  if (!process.env.MEXC_API_KEY || !process.env.MEXC_API_SECRET) return null
  try {
    const assets = (await getAccountAssets()) as MexcAsset[]
    const usdt = Array.isArray(assets) ? assets.find((a) => a.currency === "USDT") : null
    if (!usdt) return { error: "No USDT asset found" }
    return { availableBalance: usdt.availableBalance, equity: usdt.equity, unrealized: usdt.unrealized, positionMargin: usdt.positionMargin }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to fetch live account" }
  }
}`
const fnNew = `async function fetchLiveAccount(exchange: Exchange) {
  try {
    const assets = (await getExchangeClient(exchange).getAccountAssets()) as AccountAsset[]
    const usdt = Array.isArray(assets) ? assets.find((a) => a.currency === "USDT") : null
    if (!usdt) return { error: "No USDT asset found" }
    return { availableBalance: usdt.availableBalance, equity: usdt.equity, unrealized: usdt.unrealized, positionMargin: usdt.positionMargin ?? 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to fetch live account" }
  }
}`
if (s.includes(fnOld)) {
  s = s.replace(fnOld, fnNew)
  console.log("ok  fetchLiveAccount -> venue-aware")
} else {
  console.log("MISS fetchLiveAccount body")
}

// 4. Update the call site to pass the venue
const callOld = `const liveAccount = cfg.mode === "live" ? await fetchLiveAccount() : null`
const callNew = `const liveAccount = cfg.mode === "live" ? await fetchLiveAccount(cfg.exchange as Exchange) : null`
if (s.includes(callOld)) {
  s = s.replace(callOld, callNew)
  console.log("ok  call site -> fetchLiveAccount(cfg.exchange)")
} else {
  console.log("MISS call site")
}

writeFileSync(f, s)
console.log("done")

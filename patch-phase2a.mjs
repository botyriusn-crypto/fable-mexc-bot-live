import { readFileSync, writeFileSync } from "fs"

function patch(file, replacements) {
  let src = readFileSync(file, "utf8")
  for (const [oldStr, newStr] of replacements) {
    const count = src.split(oldStr).length - 1
    if (count !== 1) {
      console.error(`WARN ${file}: expected 1 match, found ${count} for:\n  ${oldStr.slice(0, 70).replace(/\n/g, "\\n")}...`)
      continue
    }
    src = src.replace(oldStr, newStr)
    console.log(`patched ${file}: ${oldStr.slice(0, 45).replace(/\n/g, "\\n")}...`)
  }
  writeFileSync(file, src)
}

// ── grid.ts ────────────────────────────────────────────────────────
patch("lib/grid.ts", [
  // drop getAccountAssets from the static import (now routed via client)
  [
    `import { placePostOnlyOrder, placeMarketOrder as makerMarketOrder, fetchOrderStatus, cancelOrders, getAccountAssets } from "./mexc/private"`,
    `import { placePostOnlyOrder, placeMarketOrder as makerMarketOrder, fetchOrderStatus, cancelOrders } from "./mexc/private"`,
  ],
  // setupGrid balance read (dynamic import -> client)
  [
    `      const { getAccountAssets } = await import("./mexc/private")
      const assets = await getAccountAssets() as any[]
      await log("info", \`[Balance] Fetched \${assets.length} assets from MEXC\`);
      const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null`,
    `      const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
      const assets = await client.getAccountAssets()
      await log("info", \`[Balance] Fetched \${assets.length} assets from exchange\`);
      const usdt = assets.find((a) => a.currency === "USDT") ?? null`,
  ],
  // setupGrid balance check (static import -> client)
  [
    `      const assets = await getAccountAssets()
      const usdtAsset = assets.find((a: any) => a.currency === "USDT")`,
    `      const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
      const assets = await client.getAccountAssets()
      const usdtAsset = assets.find((a) => a.currency === "USDT")`,
  ],
  // orphan sweep: hardcoded "mexc" -> cfg.exchange
  [
    `    const exchange = getExchangeClient("mexc")`,
    `    const exchange = getExchangeClient(cfgRows[0].exchange as Exchange)`,
  ],
])

// ── engine.ts ──────────────────────────────────────────────────────
patch("lib/engine.ts", [
  // remove the mexc/private import (both symbols now routed via client)
  [
    `import { getAccountAssets, getOpenPositions as getMexcOpenPositions } from './mexc/private';`,
    ``,
  ],
  // reconcilePositions: getMexcOpenPositions -> client
  [
    `    const mexPositions = (await getMexcOpenPositions()) as any[]`,
    `    const mexPositions = await getExchangeClient(cfg.exchange as Exchange).getOpenPositions()`,
  ],
  // equity snapshot: getAccountAssets -> client
  [
    `      try {
        const assets = await getAccountAssets()
        const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null`,
    `      try {
        const assets = await getExchangeClient(cfgAfter.exchange as Exchange).getAccountAssets()
        const usdt = assets.find((a) => a.currency === "USDT") ?? null`,
  ],
])

console.log("done")

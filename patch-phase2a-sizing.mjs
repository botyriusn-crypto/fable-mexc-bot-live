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

// ── grid-sizing.ts ─────────────────────────────────────────────────
patch("lib/grid-sizing.ts", [
  // swap the mexc/private import for the client
  [
    `import { getAccountAssets } from "./mexc/private"`,
    `import { getExchangeClient, type Exchange } from "./exchange"`,
  ],
  // add botConfig to the schema import (fixes the latent missing-import bug)
  [
    `import { gridConfigs , equitySnapshots } from "./db/schema"`,
    `import { gridConfigs , equitySnapshots, botConfig } from "./db/schema"`,
  ],
  // capture exchange alongside mode
  [
    `  let mode = "paper"
  let availableBalance = 0
  try {
    const cfgRows = await db.select().from(botConfig).limit(1)
    if (cfgRows.length > 0) {
      mode = cfgRows[0].mode
    }
  } catch {}`,
    `  let mode = "paper"
  let exchange: Exchange = "mexc"
  let availableBalance = 0
  try {
    const cfgRows = await db.select().from(botConfig).limit(1)
    if (cfgRows.length > 0) {
      mode = cfgRows[0].mode
      exchange = (cfgRows[0].exchange as Exchange) ?? "mexc"
    }
  } catch {}`,
  ],
  // route the live balance read
  [
    `      const assets = (await getAccountAssets()) as any[]
      const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
      availableBalance = usdt ? Number(usdt.availableBalance) : 0
      console.log(\`[Grid Sizing] Live mode: using MEXC balance=\${availableBalance.toFixed(2)}\`)`,
    `      const assets = await getExchangeClient(exchange).getAccountAssets()
      const usdt = assets.find((a) => a.currency === "USDT") ?? null
      availableBalance = usdt ? Number(usdt.availableBalance) : 0
      console.log(\`[Grid Sizing] Live mode: using exchange balance=\${availableBalance.toFixed(2)}\`)`,
  ],
])

// ── portfolio-sizing.ts ────────────────────────────────────────────
patch("lib/portfolio-sizing.ts", [
  // add botConfig to the schema import
  [
    `import { gridConfigs } from "./db/schema"`,
    `import { gridConfigs, botConfig } from "./db/schema"`,
  ],
  // swap the mexc/private import for the client
  [
    `import { getAccountAssets } from "./mexc/private"`,
    `import { getExchangeClient, type Exchange } from "./exchange"`,
  ],
  // resolve exchange, then route the balance read
  [
    `  let availableBalance = 0
  try {
    const assets = (await getAccountAssets()) as any[]
    const usdt = Array.isArray(assets) ? assets.find((a: any) => a.currency === "USDT") : null
    availableBalance = usdt ? Number(usdt.availableBalance) : 0
  } catch {
    availableBalance = 0
  }`,
    `  let exchange: Exchange = "mexc"
  try {
    const cfgRows = await db.select().from(botConfig).limit(1)
    if (cfgRows.length > 0) exchange = (cfgRows[0].exchange as Exchange) ?? "mexc"
  } catch {}

  let availableBalance = 0
  try {
    const assets = await getExchangeClient(exchange).getAccountAssets()
    const usdt = assets.find((a) => a.currency === "USDT") ?? null
    availableBalance = usdt ? Number(usdt.availableBalance) : 0
  } catch {
    availableBalance = 0
  }`,
  ],
])

console.log("done")

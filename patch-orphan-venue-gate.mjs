import { readFileSync, writeFileSync } from "fs"

const f = "lib/grid.ts"
let s = readFileSync(f, "utf8")

const oldSelect = `    const cfgRows = await db
      .select({ gridEnabled: botConfig.gridEnabled })
      .from(botConfig)
      .where(eq(botConfig.id, 1))
    if (!cfgRows[0]?.gridEnabled) {
      console.log("[Reconcile] gridEnabled=false — skipping orphan reconciliation (manual trading mode)")
      return
    }`

const newSelect = `    const cfgRows = await db
      .select({ gridEnabled: botConfig.gridEnabled, exchange: botConfig.exchange })
      .from(botConfig)
      .where(eq(botConfig.id, 1))
    if (!cfgRows[0]?.gridEnabled) {
      console.log("[Reconcile] gridEnabled=false — skipping orphan reconciliation (manual trading mode)")
      return
    }
    // Venue gate: this sweep is MEXC-specific (reads holdVol/positionType/openAvgPrice
    // and calls getMexcSpecAsync). Never run it on another venue — it would
    // force-close manual orders the bot has no tracking record for.
    if ((cfgRows[0]?.exchange ?? "mexc") !== "mexc") {
      console.log(\`[Reconcile] exchange=\${cfgRows[0]?.exchange} — skipping MEXC-only orphan reconciliation\`)
      return
    }`

if (s.includes(oldSelect)) {
  s = s.replace(oldSelect, newSelect)
  console.log("ok  venue gate + exchange select added")
} else {
  console.log("MISS gate block anchor — check the exact whitespace")
}

writeFileSync(f, s)
console.log("done")

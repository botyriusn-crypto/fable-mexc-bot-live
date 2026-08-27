import { readFileSync, writeFileSync } from "fs"

// 1. Code default in lib/sniper.ts
let s = readFileSync("lib/sniper.ts", "utf8")
const old = `  minStopPct: 0.008,`
const neu = `  minStopPct: 0.015,`
if (s.includes(old)) {
  s = s.replace(old, neu)
  console.log("ok  sniper.ts minStopPct default -> 0.015")
} else {
  console.log("MISS sniper.ts minStopPct default")
}
writeFileSync("lib/sniper.ts", s)

// 2. Schema default in lib/db/schema.ts
let d = readFileSync("lib/db/schema.ts", "utf8")
const dOld = `sniperMinStopPct: doublePrecision("sniper_min_stop_pct").notNull().default(0.008),`
const dNeu = `sniperMinStopPct: doublePrecision("sniper_min_stop_pct").notNull().default(0.015),`
if (d.includes(dOld)) {
  d = d.replace(dOld, dNeu)
  console.log("ok  schema sniperMinStopPct default -> 0.015")
} else {
  console.log("MISS schema sniperMinStopPct default")
}
writeFileSync("lib/db/schema.ts", d)

console.log("done")

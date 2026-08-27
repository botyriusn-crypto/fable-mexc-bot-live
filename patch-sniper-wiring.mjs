import { readFileSync, writeFileSync } from "fs"

const f = "lib/sniper.ts"
let s = readFileSync(f, "utf8")

const old = `const sig = detectSniper(_cl, snap, t.fundingRate, { sigmaExtreme, volumeSurgeMult })`
const neu = `const sig = detectSniper(_cl, snap, t.fundingRate, { sigmaExtreme, volumeSurgeMult, minStopPct, tpSlRatio })`

if (s.includes(old)) {
  s = s.replace(old, neu)
  console.log("ok  wired minStopPct + tpSlRatio into detectSniper")
} else {
  console.log("MISS detectSniper call site — paste the exact line")
}

writeFileSync(f, s)
console.log("done")

import { readFileSync, writeFileSync } from "fs"

const f = "lib/sniper.ts"
let s = readFileSync(f, "utf8")

const old = `const sig = detectSniper(_cl, snap, t.fundingRate, { sigmaExtreme, volumeSurgeMult, minStopPct, tpSlRatio })`
const neu = `const sig = detectSniper(_cl, snap, t.fundingRate, { sigmaExtreme, volumeSurgeMult, minStopPct, tpSlRatio, longStopBufferAtr: true })`

if (s.includes(old)) {
  s = s.replace(old, neu)
  console.log("ok  longStopBufferAtr: true wired into detectSniper")
} else {
  console.log("MISS detectSniper call site — paste the exact line")
}

writeFileSync(f, s)
console.log("done")

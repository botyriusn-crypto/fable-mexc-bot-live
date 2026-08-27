import fs from "fs"
const path = "lib/grid.ts"
let src = fs.readFileSync(path, "utf8")

const anchor = `): Promise<boolean> {
  // ATOMIC CLAIM: only one concurrent caller can ever win this update (only`

const replacement = `): Promise<boolean> {
  // DEFENSIVE GUARD: a naked sell (no buyPrice) is a short-open, never a
  // long-close. Refuse to book a phantom zero-PnL long if any future path
  // reaches here without a buyPrice.
  if (order.buyPrice == null) {
    await log("error", \`Grid \${order.symbol}: settleGridSell called on naked sell (no buyPrice) — refusing to book phantom long\`)
    return false
  }

  // ATOMIC CLAIM: only one concurrent caller can ever win this update (only`

if (!src.includes(anchor)) { console.error("anchor not found"); process.exit(1) }
src = src.replace(anchor, replacement)
fs.writeFileSync(path, src)
console.log("patched settleGridSell guard")

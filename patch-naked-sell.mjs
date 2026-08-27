import fs from "fs"
const path = "lib/grid.ts"
let src = fs.readFileSync(path, "utf8")

// 1) Widen the first naked-sell guard: catch ALL naked sells (auto + neutral),
//    not just direction === "neutral". A naked sell (no buyPrice) is always a
//    short-open, never a long-close.
const before1 = 'if (o.buyPrice == null && (gc as any).direction === "neutral") {'
const after1  = 'if (o.buyPrice == null) {'
if (!src.includes(before1)) { console.error("guard #1 not found"); process.exit(1) }
src = src.replace(before1, after1)

// 2) Remove the now-redundant duplicate guard (identical condition, dead code).
const re = /if \(o\.buyPrice == null && gc\.direction === "neutral"\) \{[\s\S]*?continue\s*\n\s*\}/
if (!re.test(src)) { console.error("duplicate guard block not found"); process.exit(1) }
src = src.replace(re, "")

fs.writeFileSync(path, src)
console.log("patched lib/grid.ts")

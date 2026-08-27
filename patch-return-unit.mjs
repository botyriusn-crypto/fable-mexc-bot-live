import fs from "fs"

// 1. schema.ts — add returnUnit column (drizzle source of truth)
let s = fs.readFileSync("lib/db/schema.ts", "utf8")
const sAnchor = `  outcomeReturn: doublePrecision("outcome_return"),`
if (!s.includes(sAnchor)) { console.error("schema anchor not found"); process.exit(1) }
s = s.replace(sAnchor, `${sAnchor}\n  returnUnit: text("return_unit"),`)
fs.writeFileSync("lib/db/schema.ts", s)
console.log("patched schema.ts")

// 2. engine.ts — mark percent
let e = fs.readFileSync("lib/engine.ts", "utf8")
const eAnchor = `      outcomeDirection,
      outcomeReturn,`
if (!e.includes(eAnchor)) { console.error("engine anchor not found"); process.exit(1) }
e = e.replace(eAnchor, `      outcomeDirection,
      outcomeReturn,
      returnUnit: "percent",`)
fs.writeFileSync("lib/engine.ts", e)
console.log("patched engine.ts")

// 3. sniper.ts — mark r_multiple
let sn = fs.readFileSync("lib/sniper.ts", "utf8")
const snAnchor = `      outcomeReturn: rMultiple, // R-multiple (not raw %), so sumReturn = total R`
if (!sn.includes(snAnchor)) { console.error("sniper anchor not found"); process.exit(1) }
sn = sn.replace(snAnchor, `      outcomeReturn: rMultiple, // R-multiple (not raw %), so sumReturn = total R
      returnUnit: "r_multiple",`)
fs.writeFileSync("lib/sniper.ts", sn)
console.log("patched sniper.ts")

// 4. shadow-evaluator.ts — mark percent
let sh = fs.readFileSync("lib/shadow-evaluator.ts", "utf8")
const shAnchor = `      outcomeReturn: ret,`
if (!sh.includes(shAnchor)) { console.error("shadow anchor not found"); process.exit(1) }
sh = sh.replace(shAnchor, `      outcomeReturn: ret,
      returnUnit: "percent",`)
fs.writeFileSync("lib/shadow-evaluator.ts", sh)
console.log("patched shadow-evaluator.ts")

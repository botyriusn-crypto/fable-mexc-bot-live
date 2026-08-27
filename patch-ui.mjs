import fs from "fs"

// 1. state/route.ts — raise trades cap 50 -> 500
let s = fs.readFileSync("app/api/bot/state/route.ts", "utf8")
const sAnchor = `db.select().from(trades).orderBy(desc(trades.closedAt)).limit(50),`
if (!s.includes(sAnchor)) { console.error("state anchor not found"); process.exit(1) }
s = s.replace(sAnchor, `db.select().from(trades).orderBy(desc(trades.closedAt)).limit(500),`)
fs.writeFileSync("app/api/bot/state/route.ts", s)
console.log("patched state/route.ts (50 -> 500)")

// 2. settings-panel.tsx — allow exchange switch in paper mode
let p = fs.readFileSync("components/bot/settings-panel.tsx", "utf8")
const pAnchor = `disabled={cfg.status === "running"}`
if (!p.includes(pAnchor)) { console.error("settings anchor not found"); process.exit(1) }
p = p.replace(pAnchor, `disabled={cfg.status === "running" && cfg.mode === "live"}`)
fs.writeFileSync("components/bot/settings-panel.tsx", p)
console.log("patched settings-panel.tsx (exchange switchable in paper mode)")

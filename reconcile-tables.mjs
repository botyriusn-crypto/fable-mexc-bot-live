import pg from "pg"
import fs from "fs"

// 1) Extract every pgTable("...") name from schema.ts
const schema = fs.readFileSync("lib/db/schema.ts", "utf8")
const defined = [...schema.matchAll(/pgTable\("([^"]+)"/g)].map(m => m[1])
const definedSet = new Set(defined)

// 2) Query actual tables in fable_mexc_bot
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const { rows } = await c.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name
`)
const actual = rows.map(r => r.table_name)
const actualSet = new Set(actual)

// 3) Diff
const missing = defined.filter(t => !actualSet.has(t))
const extra = actual.filter(t => !definedSet.has(t))

console.log(`Defined in schema.ts: ${defined.length}`)
console.log(`Actual in fable_mexc_bot: ${actual.length}`)
console.log(`\n=== MISSING from DB (in schema but not created) ===`)
console.log(missing.length ? missing.join("\n") : "(none)")
console.log(`\n=== EXTRA in DB (not in schema.ts) ===`)
console.log(extra.length ? extra.join("\n") : "(none)")
await c.end()

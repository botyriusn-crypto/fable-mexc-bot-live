import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Recent shadow entries: entry vs tp vs sl
const shadow = await c.query(`
  SELECT symbol, side, entry_price, tp_price, sl_price, status, resolved_pnl, opened_at, resolved_at
  FROM grid_flow_shadow
  ORDER BY opened_at DESC
  LIMIT 20
`)
console.log("=== grid_flow_shadow (recent 20) ===")
console.table(shadow.rows)

// Count of shadow entries where tp == entry (the bug signature)
const collapse = await c.query(`
  SELECT COUNT(*) AS collapsed,
         COUNT(*) FILTER (WHERE tp_price = entry_price) AS tp_eq_entry,
         COUNT(*) FILTER (WHERE tp_price IS NULL) AS tp_null
  FROM grid_flow_shadow
`)
console.log("\n=== collapse check ===")
console.log(JSON.stringify(collapse.rows, null, 2))

await c.end()

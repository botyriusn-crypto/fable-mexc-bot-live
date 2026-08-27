import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Orphaned naked sells: side='sell', no buy_price, still marked filled
const r = await c.query(`
  SELECT symbol, side, status, buy_price, price, COUNT(*) AS n
  FROM grid_orders
  WHERE side = 'sell' AND buy_price IS NULL AND status = 'filled'
  GROUP BY symbol, side, status, buy_price, price
  ORDER BY n DESC
`)
console.log("=== orphaned naked sells (filled, no buy_price) ===")
console.table(r.rows)

// Also check pending naked sells (short-opens still resting)
const p = await c.query(`
  SELECT symbol, side, status, buy_price, price, COUNT(*) AS n
  FROM grid_orders
  WHERE side = 'sell' AND buy_price IS NULL AND status = 'pending'
  GROUP BY symbol, side, status, buy_price, price
  ORDER BY n DESC
`)
console.log("\n=== pending naked sells (resting short-opens) ===")
console.table(p.rows)

await c.end()

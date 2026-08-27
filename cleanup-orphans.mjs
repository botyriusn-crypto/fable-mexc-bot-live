import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

await c.query("BEGIN")

// Void filled naked sells (orphaned short-opens never closed)
const filled = await c.query(`
  UPDATE grid_orders
  SET status = 'cancelled'
  WHERE side = 'sell' AND buy_price IS NULL AND status = 'filled'
`)

// Cancel pending naked sells (resting short-opens)
const pending = await c.query(`
  UPDATE grid_orders
  SET status = 'cancelled'
  WHERE side = 'sell' AND buy_price IS NULL AND status = 'pending'
`)

await c.query("COMMIT")

console.log(`DONE: voided ${filled.rowCount} filled + ${pending.rowCount} pending orphaned naked sells`)
await c.end()

import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const trades = await c.query(`
  SELECT symbol, side, entry_price, exit_price, pnl, exit_reason, opened_at, closed_at
  FROM trades
  WHERE strategy = 'grid'
  ORDER BY closed_at DESC
  LIMIT 25
`)
console.log("=== trades (grid, recent 25) ===")
console.table(trades.rows)

const collapse = await c.query(`
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE entry_price = exit_price) AS entry_eq_exit,
         COUNT(*) FILTER (WHERE pnl = 0) AS pnl_zero
  FROM trades
  WHERE strategy = 'grid'
`)
console.log("\n=== collapse check ===")
console.log(JSON.stringify(collapse.rows, null, 2))

await c.end()

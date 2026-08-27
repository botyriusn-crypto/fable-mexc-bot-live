import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Phantom signature: grid LONG, exit_reason 'tp', entry == exit, pnl == 0
const r = await c.query(`
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE side = 'long') AS long_count,
    COUNT(*) FILTER (WHERE side = 'short') AS short_count,
    MIN(closed_at) AS earliest,
    MAX(closed_at) AS latest,
    COALESCE(SUM(pnl), 0) AS sum_pnl,
    COALESCE(SUM(fees), 0) AS sum_fees
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl = 0
`)
console.log("=== phantom trades (dry-run) ===")
console.table(r.rows)

// Breakdown by symbol
const bySym = await c.query(`
  SELECT symbol, COUNT(*) AS n
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl = 0
  GROUP BY symbol
  ORDER BY n DESC
`)
console.log("\n=== by symbol ===")
console.table(bySym.rows)

// Sanity: are there any grid 'tp' trades with entry==exit but pnl != 0?
const nonzero = await c.query(`
  SELECT COUNT(*) AS n
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl != 0
`)
console.log("\n=== entry==exit but pnl != 0 (should be 0) ===")
console.table(nonzero.rows)

await c.end()

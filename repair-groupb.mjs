import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Group B: entry == exit, tp, but pnl != 0
const r = await c.query(`
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE side = 'long') AS long_count,
    COUNT(*) FILTER (WHERE side = 'short') AS short_count,
    MIN(pnl) AS min_pnl,
    MAX(pnl) AS max_pnl,
    ROUND(AVG(pnl)::numeric, 6) AS avg_pnl,
    COALESCE(SUM(pnl), 0) AS sum_pnl,
    COALESCE(SUM(fees), 0) AS sum_fees,
    MIN(closed_at) AS earliest,
    MAX(closed_at) AS latest
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl != 0
`)
console.log("=== group B (entry==exit, pnl != 0) ===")
console.table(r.rows)

// pnl distribution: are they all negative (=-fees)?
const dist = await c.query(`
  SELECT
    CASE
      WHEN pnl < 0 THEN 'negative'
      WHEN pnl > 0 THEN 'positive'
      ELSE 'zero'
    END AS sign,
    COUNT(*) AS n,
    ROUND(SUM(pnl)::numeric, 6) AS sum_pnl
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl != 0
  GROUP BY 1
`)
console.log("\n=== group B pnl sign ===")
console.table(dist.rows)

// Sample rows to eyeball
const sample = await c.query(`
  SELECT symbol, side, entry_price, exit_price, pnl, fees, exit_reason, closed_at
  FROM trades
  WHERE strategy = 'grid'
    AND exit_reason = 'tp'
    AND entry_price = exit_price
    AND pnl != 0
  ORDER BY closed_at DESC
  LIMIT 15
`)
console.log("\n=== group B sample (15) ===")
console.table(sample.rows)

await c.end()

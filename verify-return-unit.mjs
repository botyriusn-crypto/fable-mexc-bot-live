import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const r = await c.query(`
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL) AS resolved,
    COUNT(*) FILTER (WHERE return_unit = 'r_multiple') AS r_multiple,
    COUNT(*) FILTER (WHERE return_unit = 'percent') AS percent,
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL AND return_unit IS NULL) AS resolved_but_unflagged
  FROM classifier_decisions
`)
console.log("=== return_unit verification ===")
console.table(r.rows)

// Breakdown by strategy for the resolved-but-unflagged rows (if any)
const un = await c.query(`
  SELECT strategy, COUNT(*) AS n
  FROM classifier_decisions
  WHERE outcome_return IS NOT NULL AND return_unit IS NULL
  GROUP BY strategy
  ORDER BY n DESC
`)
console.log("\n=== resolved but UNFLAGGED, by strategy ===")
console.table(un.rows)

await c.end()

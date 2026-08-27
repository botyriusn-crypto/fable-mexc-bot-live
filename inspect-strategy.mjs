import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Strategy breakdown of resolved rows
const byStrategy = await c.query(`
  SELECT strategy, COUNT(*) AS n,
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL) AS resolved,
    MIN(resolved_at) AS earliest_resolved,
    MAX(resolved_at) AS latest_resolved
  FROM classifier_decisions
  GROUP BY strategy
  ORDER BY n DESC
`)
console.log("=== by strategy ===")
console.table(byStrategy.rows)

// Rows resolved BEFORE the R-multiple change (legacy percent-return)
// — need to know when sniper.ts R-multiple went live. Check the boundary:
const boundary = await c.query(`
  SELECT
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL AND ABS(outcome_return) < 0.5) AS small_vals,
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL AND ABS(outcome_return) >= 0.5) AS large_vals
  FROM classifier_decisions
`)
console.log("\n=== magnitude split (raw % are usually <0.5, R can be >1) ===")
console.table(boundary.rows)

await c.end()

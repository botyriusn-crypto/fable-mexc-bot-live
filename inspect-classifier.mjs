import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Full column list for classifier_decisions
const cols = await c.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'classifier_decisions'
  ORDER BY ordinal_position
`)
console.log("=== classifier_decisions columns ===")
console.table(cols.rows)

// How many rows have outcome_return set, and their distribution
const r = await c.query(`
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE outcome_return IS NOT NULL) AS resolved,
    COUNT(*) FILTER (WHERE outcome_return IS NULL) AS unresolved,
    MIN(outcome_return) AS min_ret,
    MAX(outcome_return) AS max_ret,
    ROUND(AVG(outcome_return)::numeric, 6) AS avg_ret
  FROM classifier_decisions
`)
console.log("\n=== outcome_return stats ===")
console.table(r.rows)

// Sample resolved rows
const sample = await c.query(`
  SELECT id, symbol, strategy, candidate_direction, entry_price, outcome_return, resolved_at
  FROM classifier_decisions
  WHERE outcome_return IS NOT NULL
  ORDER BY resolved_at DESC
  LIMIT 15
`)
console.log("\n=== sample resolved rows ===")
console.table(sample.rows)

await c.end()

import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Find tables with an outcome_return column
const tables = await c.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE column_name = 'outcome_return'
`)
console.log("=== tables with outcome_return ===")
console.table(tables.rows)

await c.end()

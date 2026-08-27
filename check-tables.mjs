import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const { rows } = await c.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name LIKE '%grid_flow%'
  ORDER BY table_name
`)
console.log("grid_flow tables:", JSON.stringify(rows, null, 2))
await c.end()

import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

await c.query("BEGIN")

await c.query(`ALTER TABLE classifier_decisions ADD COLUMN IF NOT EXISTS return_unit text`)

const r = await c.query(`
  UPDATE classifier_decisions
  SET return_unit = CASE WHEN strategy = 'sniper' THEN 'r_multiple' ELSE 'percent' END
  WHERE outcome_return IS NOT NULL AND return_unit IS NULL
`)

await c.query("COMMIT")
console.log(`backfilled ${r.rowCount} rows with return_unit`)
await c.end()

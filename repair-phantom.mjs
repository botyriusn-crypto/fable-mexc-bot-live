import pg from "pg"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Detect the paper-balance column name (camelCase vs snake_case)
const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'bot_config'
`)
const names = cols.rows.map(r => r.column_name)
const balCol = names.find(n => n.toLowerCase() === 'paperbalance' || n.toLowerCase() === 'paper_balance')
if (!balCol) { console.error("paper balance column not found:", names); process.exit(1) }
console.log("paper balance column:", balCol)

// Pre-flight counts
const pre = await c.query(`
  SELECT
    COUNT(*) FILTER (WHERE pnl = 0) AS group_a,
    COUNT(*) FILTER (WHERE pnl != 0) AS group_b,
    COALESCE(SUM(fees) FILTER (WHERE pnl != 0), 0) AS fee_to_restore
  FROM trades
  WHERE strategy = 'grid' AND exit_reason = 'tp' AND entry_price = exit_price
`)
const { group_a, group_b, fee_to_restore } = pre.rows[0]
console.log(`pre-flight: group A = ${group_a}, group B = ${group_b}, fees to restore = ${fee_to_restore}`)

await c.query("BEGIN")

const del = await c.query(`
  DELETE FROM trades
  WHERE strategy = 'grid' AND exit_reason = 'tp' AND entry_price = exit_price
`)
const deleted = del.rowCount

await c.query(`UPDATE bot_config SET ${balCol} = ${balCol} + $1 WHERE id = 1`, [fee_to_restore])

await c.query("COMMIT")

console.log(`\nDONE: deleted ${deleted} phantom trades, restored ${fee_to_restore} USDT to ${balCol}`)
await c.end()

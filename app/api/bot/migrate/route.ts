import { NextResponse } from "next/server"
import { Client } from "pg"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TABLES = ["bot_config", "grid_configs", "trades", "trade_features", "ml_model", "classifier_decisions", "ai_recommendations"]

export async function POST(req: Request) {
  const { sourceUrl } = await req.json()
  if (!sourceUrl?.startsWith("postgres")) return NextResponse.json({ error: "bad source url" }, { status: 400 })
  const src = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } })
  const dst = new Client({ connectionString: process.env.DATABASE_URL, ssl: false })
  await src.connect(); await dst.connect()
  const counts: Record<string, number> = {}
  try {
    for (const t of TABLES) {
      const exists = await src.query(`SELECT to_regclass('${t}') AS r`)
      if (!exists.rows[0].r) continue
      const res = await src.query(`SELECT * FROM ${t}`)
      for (const row of res.rows) {
        const cols = Object.keys(row)
        const ph = cols.map((_, i) => `$${i + 1}`).join(", ")
        const upd = cols.map(c => `"${c}" = EXCLUDED."${c}"`).join(", ")
        await dst.query(
          `INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${upd}`,
          cols.map(c => row[c])
        ).catch(() => {})
      }
      await dst.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`).catch(() => {})
      counts[t] = res.rows.length
    }
    return NextResponse.json({ success: true, counts })
  } finally { await src.end(); await dst.end() }
}

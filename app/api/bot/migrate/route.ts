import { NextResponse } from "next/server"
import { Client } from "pg"
import { requireAuth } from "@/lib/auth"
import { checkMigrateSource } from "@/lib/migrate-guard"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Compile-time constant: every entry is a hardcoded, known-safe table name.
// These values are NEVER user-controlled, so interpolating them into SQL
// identifiers below is safe. The runtime regex check is defense-in-depth.
const TABLES = ["bot_config", "grid_configs", "trades", "trade_features", "ml_model", "classifier_decisions", "ai_recommendations"]

// Postgres identifiers we allow to be interpolated into SQL. All TABLES
// entries must match this; validated at runtime as a second line of defense.
const SAFE_IDENT = /^[a-z_]+$/

export async function POST(req: Request) {
  // Defense-in-depth: this endpoint can OVERWRITE the production database.
  // Enforce auth here in addition to the central middleware.
  const authError = await requireAuth(req)
  if (authError) return authError
  const { sourceUrl } = await req.json()

  // ── SSRF host allowlist (fail closed) ──────────────────────────────────────
  // The source URL is attacker-controllable, and this server connects OUT to
  // it. Without an allowlist an attacker could point us at internal hosts
  // (metadata endpoints, internal Postgres, etc.). Only hosts explicitly listed
  // in MIGRATE_ALLOWED_HOSTS (comma-separated) may be targeted. If the env var
  // is unset/empty, ALL migrations are refused. See lib/migrate-guard.ts.
  const guard = checkMigrateSource(sourceUrl, process.env.MIGRATE_ALLOWED_HOSTS)
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const src = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: true } })
  const dst = new Client({ connectionString: process.env.DATABASE_URL, ssl: false })
  await src.connect(); await dst.connect()
  const counts: Record<string, number> = {}
  try {
    for (const t of TABLES) {
      // Defense-in-depth: refuse any table name that is not a plain lowercase
      // identifier before interpolating it into SQL.
      if (!SAFE_IDENT.test(t)) continue
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

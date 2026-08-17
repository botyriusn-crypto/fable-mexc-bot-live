#!/usr/bin/env node
/**
 * Idempotent application of migration 0001 (quant-upgrades columns).
 *
 * Adds three NULLABLE columns that the updated Drizzle schema now selects.
 * Without these, every read of bot_config / grid_configs / grid_orders throws
 * ("column does not exist") and /api/bot/state returns 500.
 *
 * Safe to run multiple times — uses ADD COLUMN IF NOT EXISTS, so it will not
 * clash with tables that already exist or columns that were already added.
 *
 * Usage (needs DATABASE_URL in the environment — same one the app uses):
 *   node scripts/apply-migration-0001.mjs
 *
 * On the Fly machine (DATABASE_URL is already set there):
 *   fly ssh console -C "node /app/scripts/apply-migration-0001.mjs"
 */
import pg from "pg"
const { Pool } = pg

let dbUrl = (process.env.DATABASE_URL || "").replace(/"/g, "")
if (!dbUrl) {
  console.error("ERROR: DATABASE_URL is not set.")
  process.exit(1)
}
// Mirror lib/db/index.ts behaviour for sslmode=require URLs.
if (dbUrl.includes("sslmode=require") && !dbUrl.includes("uselibpqcompat")) {
  dbUrl += (dbUrl.includes("?") ? "&" : "?") + "uselibpqcompat=true"
}

const STATEMENTS = [
  ['bot_config.ai_last_analysis', 'ALTER TABLE "bot_config"  ADD COLUMN IF NOT EXISTS "ai_last_analysis" timestamp with time zone'],
  ['grid_configs.metadata',       'ALTER TABLE "grid_configs" ADD COLUMN IF NOT EXISTS "metadata" jsonb'],
  ['grid_orders.synced_at',       'ALTER TABLE "grid_orders"  ADD COLUMN IF NOT EXISTS "synced_at" timestamp with time zone'],
]

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})

;(async () => {
  console.log("[migrate-0001] Connecting:", dbUrl.replace(/:[^:@]+@/, ":****@"))
  for (const [label, sql] of STATEMENTS) {
    await pool.query(sql)
    console.log(`[migrate-0001] OK  ${label}`)
  }
  console.log("[migrate-0001] DONE — all columns present.")
  await pool.end()
})().catch((err) => {
  console.error("[migrate-0001] FAILED:", err.message)
  process.exit(1)
})

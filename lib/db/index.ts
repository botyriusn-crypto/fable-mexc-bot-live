import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"

// Get connection string and strip any quotes
let dbUrl = (process.env.DATABASE_URL || "").replace(/"/g, "")
if (dbUrl.includes("sslmode=require") && !dbUrl.includes("uselibpqcompat")) {
  dbUrl += (dbUrl.includes("?") ? "&" : "?") + "uselibpqcompat=true"
}

// Debug: Log sanitized connection string (hides password)
console.log('[DB] Connecting to:', dbUrl.replace(/:[^:@]+@/, ':****@'))

// Configure pool for Neon with proper settings
export const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 2, // Keep pool small for serverless
  idleTimeoutMillis: 10000, // Shorter idle timeout
  connectionTimeoutMillis: 10000,
})

// Retry wrapper for Neon cold starts
const originalQuery = pool.query.bind(pool)
pool.query = async (...args: any[]) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await originalQuery(...args)
    } catch (err: any) {
      console.error('[DB] Query error:', err.message, 'Code:', err.code)
      try {
        const q = args[0]
        const qText = typeof q === 'string' ? q : q?.text
        const qParams = typeof q === 'string' ? undefined : q?.values
        console.error('[DB] Failing query text:', qText)
        if (qParams) console.error('[DB] Failing query params:', JSON.stringify(qParams))
      } catch (logErr) {
        console.error('[DB] Could not log failing query:', logErr)
      }
      // Retry on common transient network errors (Neon cold starts, DNS drops, etc.)
      if (['ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(err?.code) && attempt < 2) {
        console.log(`[DB] Connection issue, retry ${attempt + 1}/3...`)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }
      throw err
    }
  }
}

export const db = drizzle(pool, { schema })

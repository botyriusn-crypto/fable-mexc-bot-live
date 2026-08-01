import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"

// Neon-compatible pool with retry and keep-alive
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
})

// Retry wrapper for Neon cold starts
const originalQuery = pool.query.bind(pool)
pool.query = async (...args: any[]) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await originalQuery(...args)
    } catch (err: any) {
      if (err?.code === 'ETIMEDOUT' && attempt < 2) {
        console.log(`[DB] Neon waking up, retry ${attempt + 1}/3...`)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }
      throw err
    }
  }
}
export const db = drizzle(pool, { schema })

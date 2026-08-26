import { db } from "./db"
import { botLogs } from "./db/schema"

export async function log(level: string, message: string, details?: any): Promise<void> {
  try {
    await db.insert(botLogs).values({
      level,
      message,
      details: details || {},
    })
    console.log(`[${level.toUpperCase()}] ${message}`)
  } catch (err) {
    console.error(`[LOG ERROR] ${level}: ${message}`, err)
  }
}

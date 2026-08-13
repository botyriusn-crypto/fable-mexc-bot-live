// Watchdog — silent-failure detector + auto-fixer. Runs in the engine tick (10min throttle).
import { db } from "./db"
import { sql } from "drizzle-orm"
import { log } from "./logger"
import { isRotationEnabled, getLastRotationTime } from "./portfolio-rotator"

export interface WatchdogReport {
  lastRun: number
  issues: string[]
  fixed: string[]
  historicalPhantom: number
  rotationAgeH: number | null
}

let report: WatchdogReport = { lastRun: 0, issues: [], fixed: [], historicalPhantom: 0, rotationAgeH: null }
let prev: { balance: number; sumPnl: number } | null = null
let lastRunAt = 0

export function getWatchdogReport(): WatchdogReport { return report }

const TABLES = ["trades", "trade_features", "classifier_decisions", "grid_configs", "grid_orders", "advisor_variants"]
const STARTING_BALANCE = 9819.74

const rows = (r: any) => (Array.isArray(r) ? r : r?.rows ?? [])

export async function runWatchdog(): Promise<void> {
  const now = Date.now()
  if (now - lastRunAt < 10 * 60 * 1000) return
  lastRunAt = now

  const issues: string[] = []
  const fixed: string[] = []

  // 1) Sequence healer — auto-fix the bug that ate $330
  for (const t of TABLES) {
    try {
      const seq = rows(await db.execute(sql`SELECT last_value, is_called FROM pg_get_serial_sequence(${t}, 'id')`))[0]
      const max = rows(await db.execute(sql`SELECT COALESCE(MAX(id), 0) AS m FROM ${sql.raw(t)}`))[0]
      if (!seq || !max) continue
      const nextVal = seq.is_called ? Number(seq.last_value) + 1 : Number(seq.last_value)
      const maxId = Number(max.m)
      if (nextVal <= maxId) {
        await db.execute(sql`SELECT setval(pg_get_serial_sequence(${t}, 'id'), ${maxId})`)
        fixed.push(`${t} seq healed`)
      }
    } catch {}
  }

  // 2) Phantom-PnL detector (delta-based, self-baselining)
  try {
    const b = rows(await db.execute(sql`SELECT paper_balance FROM bot_config WHERE id = 1`))[0]
    const p = rows(await db.execute(sql`SELECT COALESCE(SUM(pnl), 0) AS s FROM trades`))[0]
    if (b && p) {
      const balance = Number(b.paper_balance)
      const sumPnl = Number(p.s)
      report.historicalPhantom = Math.round((balance - (STARTING_BALANCE + sumPnl)) * 100) / 100
      if (prev) {
        const drift = (balance - prev.balance) - (sumPnl - prev.sumPnl)
        if (drift > 1) issues.push(`new unrecorded PnL $${drift.toFixed(2)} since last check`)
      }
      prev = { balance, sumPnl }
    }
  } catch {}

  // 3) Rotation health
  if (isRotationEnabled()) {
    const last = getLastRotationTime()
    if (last > 0) {
      const ageH = (now - last) / 3600000
      report.rotationAgeH = Math.round(ageH * 10) / 10
      if (ageH > 8) issues.push(`rotation stale (${ageH.toFixed(1)}h)`)
    }
  }

  report = { lastRun: now, issues, fixed, historicalPhantom: report.historicalPhantom, rotationAgeH: report.rotationAgeH }

  if (issues.length || fixed.length) {
    await log("info", `🛡️ Watchdog: ${fixed.length ? "auto-fixed: " + fixed.join(", ") : ""}${issues.length ? " | issues: " + issues.join(", ") : ""}`).catch(() => {})
  }
}

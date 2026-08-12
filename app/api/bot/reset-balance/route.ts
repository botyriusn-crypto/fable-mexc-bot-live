import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, trades } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const start = typeof body.start === "number" ? body.start : 10145.40
    const all = await db.select().from(trades)
    const sum = (arr: any[]) => arr.reduce((s, t) => s + parseFloat(t.pnl), 0)

    const candidates = [
      "2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z", "2026-08-11T12:00:00Z",
      "2026-08-11T18:00:00Z", "2026-08-11T19:00:00Z", "2026-08-11T20:00:00Z",
      "2026-08-12T00:00:00Z",
    ].map((iso) => ({
      since: iso,
      pnl: +sum(all.filter((t) => t.closedAt && new Date(t.closedAt) >= new Date(iso))).toFixed(2),
      n: all.filter((t) => t.closedAt && new Date(t.closedAt) >= new Date(iso)).length,
    }))

    if (body.since) {
      const since = new Date(body.since)
      const win = all.filter((t) => t.closedAt && new Date(t.closedAt) >= since)
      const newBalance = start + sum(win)
      await db.update(botConfig).set({ paperBalance: newBalance }).where(eq(botConfig.id, 1))
      return NextResponse.json({ success: true, newBalance, trades: win.length, pnl: +sum(win).toFixed(2), candidates })
    }
    return NextResponse.json({ success: true, report: true, totalTrades: all.length, allTimePnl: +sum(all).toFixed(2), candidates })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botConfig, trades } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const allTrades = await db.select().from(trades)
    const totalPnl = allTrades.reduce((s, t) => s + parseFloat(t.pnl), 0)
    const newBalance = 10145.40 + totalPnl
    await db.update(botConfig).set({ paperBalance: newBalance }).where(eq(botConfig.id, 1))
    return NextResponse.json({ success: true, newBalance, totalPnl, tradeCount: allTrades.length })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

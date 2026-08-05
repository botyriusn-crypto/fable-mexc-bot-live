import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botLogs } from "@/lib/db/schema"
import { sql } from "drizzle-orm"

export const dynamic = "force-dynamic"

export async function DELETE() {
  try {
    await db.delete(botLogs)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown" }, { status: 500 })
  }
}

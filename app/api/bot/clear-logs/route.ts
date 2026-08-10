import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { botLogs } from "@/lib/db/schema"
import { sql } from "drizzle-orm"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

export async function DELETE(request: NextRequest) {
  // Verify API key authentication
  const authError = verifyApiKey(request)
  if (authError) return authError
  
  try {
    await db.delete(botLogs)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown" }, { status: 500 })
  }
}

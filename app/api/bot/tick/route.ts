import { NextResponse } from "next/server"
import { runTick } from "@/lib/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
  // If CRON_SECRET is set, require it; otherwise allow (dev/preview).
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = request.headers.get("authorization")
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const result = await runTick()
  return NextResponse.json(result)
}

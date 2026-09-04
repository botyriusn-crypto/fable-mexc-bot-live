import { NextResponse } from "next/server"
import { runSwingBreakoutTick } from "@/lib/swing-breakout"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Secure like the main tick endpoint
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.warn(
      "[Swing Tick Route] CRON_SECRET is not set — the swing tick endpoint is UNPROTECTED. " +
        "Set CRON_SECRET in your environment to secure it.",
    )
    return true
  }
  const auth = req.headers.get("authorization")
  if (auth === `Bearer ${secret}`) return true
  if (req.headers.get("x-cron-secret") === secret) return true
  try {
    const url = new URL(req.url)
    if (url.searchParams.get("secret") === secret) return true
  } catch {}
  return false
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    console.log("[Swing Tick] Starting tick...")
    await runSwingBreakoutTick()
    console.log("[Swing Tick] Tick completed")
    return NextResponse.json({ status: "ok" })
  } catch (err: any) {
    console.error("[Swing Tick] Error:", err)
    return NextResponse.json({ status: "error", detail: err?.message || "Unknown" }, { status: 500 })
  }
}

export async function GET(req: Request) { return handle(req) }
export async function POST(req: Request) { return handle(req) }

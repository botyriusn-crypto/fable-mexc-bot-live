import { NextResponse } from "next/server"
import { runTick } from "@/lib/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// This endpoint EXECUTES LIVE TRADES on every call, so it must not be openly
// callable. When CRON_SECRET is set we require it. The scheduler that pings this
// endpoint (e.g. a Fly.io scheduled machine, an external cron/uptime monitor, or
// `curl` from a Fly cron job) must send the secret via one of:
//   - `Authorization: Bearer <CRON_SECRET>`
//   - `x-cron-secret: <CRON_SECRET>` header
//   - `?secret=<CRON_SECRET>` query param
// If CRON_SECRET is unset we allow the call for backward compatibility but log a
// loud warning — set the secret.
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.warn(
      "[Tick Route] CRON_SECRET is not set — the trading tick endpoint is UNPROTECTED. " +
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
  } catch {
    /* ignore malformed URL */
  }
  return false
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 })
  }
  try {
    const result = await runTick()
    return NextResponse.json(result)
  } catch (err: any) {
    console.error("[Tick Route] Error:", err)
    return NextResponse.json({ status: "error", detail: err?.message || "Unknown" }, { status: 500 })
  }
}

export async function GET(req: Request) {
  return handle(req)
}

// Allow POST too (some schedulers/uptime monitors prefer POST).
export async function POST(req: Request) {
  return handle(req)
}

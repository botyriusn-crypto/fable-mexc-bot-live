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
//
// If CRON_SECRET is unset we FAIL CLOSED and reject the call. The previous
// behaviour was to allow it with a warning, which meant a missing/typo'd env
// var silently left a live-order-placing endpoint publicly triggerable — a
// warning is not an access control.
//
// Local development against an unprotected endpoint is still possible, but it
// requires an EXPLICIT opt-in (ALLOW_UNSECURED_TICK=1) so it can never happen
// by accident in production.
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    if (process.env.ALLOW_UNSECURED_TICK === "1") {
      console.warn(
        "[Tick Route] CRON_SECRET is not set and ALLOW_UNSECURED_TICK=1 — the trading tick " +
          "endpoint is UNPROTECTED. This must never be set in production.",
      )
      return true
    }
    console.error(
      "[Tick Route] CRON_SECRET is not set — refusing to run the trading tick. " +
        "Set CRON_SECRET in your environment (and send it as a Bearer token, x-cron-secret " +
        "header or ?secret= param). For local development only, ALLOW_UNSECURED_TICK=1.",
    )
    return false
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

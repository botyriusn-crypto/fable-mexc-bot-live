import { NextResponse } from "next/server"
import { runSwingBreakoutTick } from "@/lib/swing-breakout"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// TEMPORARY: Disable auth for testing (will restore after confirming it works)
async function handle(req: Request) {
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

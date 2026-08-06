import { NextResponse } from "next/server"
import { runTick } from "@/lib/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET() {
  try {
    const result = await runTick()
    return NextResponse.json(result)
  } catch (err: any) {
    console.error("[Tick Route] Error:", err)
    return NextResponse.json({ status: "error", detail: err?.message || "Unknown" }, { status: 500 })
  }
}

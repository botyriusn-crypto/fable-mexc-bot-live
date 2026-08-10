import { NextResponse } from "next/server"
import { runTick } from "@/lib/engine"
import { verifyApiKey } from "@/lib/auth"
import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError
  try {
    const result = await runTick()
    return NextResponse.json(result)
  } catch (err: any) {
    console.error("[Tick Route] Error:", err)
    return NextResponse.json({ status: "error", detail: "Tick execution failed" }, { status: 500 })
  }
}

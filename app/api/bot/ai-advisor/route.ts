import { NextResponse } from "next/server"
import { runGridAiAdvisor } from "@/lib/ai-grid-advisor"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET() {
  const result = await runGridAiAdvisor(false)
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, recommendations: result.recommendations })
}

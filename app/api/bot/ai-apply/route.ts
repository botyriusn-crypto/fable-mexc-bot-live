import { NextResponse } from "next/server"
import { applyRecommendations } from "@/lib/ai-advisor"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const recommendations = body?.recommendations
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      return NextResponse.json({ error: "No recommendations to apply" }, { status: 400 })
    }
    const applied = await applyRecommendations(0, recommendations)
    return NextResponse.json({ success: true, applied })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Apply failed" }, { status: 500 })
  }
}

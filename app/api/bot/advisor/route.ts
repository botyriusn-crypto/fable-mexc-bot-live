import { NextResponse } from "next/server"
import { getVariants, scoreVariant } from "@/lib/advisor"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const variants = await getVariants()
    const scored = variants
      .map(v => ({ name: v.name, params: v.params, stats: v.stats, score: scoreVariant(v.stats) }))
      .sort((a, b) => b.score - a.score)
    return NextResponse.json({ variants: scored, leader: scored[0] ?? null })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, variants: [] }, { status: 500 })
  }
}

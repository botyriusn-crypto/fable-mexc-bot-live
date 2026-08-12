import { NextResponse } from "next/server"
import { checkAndRotate, setRotationEnabled, getLastRotationTime } from "@/lib/portfolio-rotator"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    
    if (body.enabled !== undefined) {
      setRotationEnabled(body.enabled)
      return NextResponse.json({ success: true, enabled: body.enabled })
    }
    
    // Manual trigger - pass null since rotator doesn't actually use exchange
    await checkAndRotate(null)
    return NextResponse.json({ success: true, lastRotation: getLastRotationTime() })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 })
  }
}

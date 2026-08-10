import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { mlModel } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { FEATURE_KEYS } from "@/lib/ml"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    const freshWeights: Record<string, any> = {
      ...Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])),
      __gen: 99
    }
    
    // ONLY update weights and bias to avoid schema mismatch errors
    await db.update(mlModel)
      .set({
        weights: freshWeights,
        bias: 0
      })
      .where(eq(mlModel.id, 1))
      
    return NextResponse.json({ success: true, message: "ML Model manually reset to neutral state." })
  } catch (err: any) {
    console.error("Reset ML Error:", err)
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}

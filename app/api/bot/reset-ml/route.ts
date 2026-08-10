import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { mlModel } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { FEATURE_KEYS } from "@/lib/ml"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Force a new generation and wipe all learned weights
    const freshWeights: Record<string, any> = { 
      ...Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])), 
      __gen: 99 
    }
    
    await db.update(mlModel)
      .set({ 
        weights: freshWeights, 
        bias: 0, 
        sampleCount: 0, 
        correctCount: 0, 
        rollingAccuracy: 0.5,
        updatedAt: sql`NOW()`
      })
      .where(eq(mlModel.id, 1))
      
    return NextResponse.json({ success: true, message: "ML Model manually reset to neutral state." })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}

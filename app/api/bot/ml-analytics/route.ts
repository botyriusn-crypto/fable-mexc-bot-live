import { NextResponse } from "next/server"
import { getConfidenceBucketedStats, getSignalFunnel, getGateRedundancy } from "@/lib/ml-analytics"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [logistic, lorentzian, funnel, redundancy] = await Promise.all([
      getConfidenceBucketedStats("logistic"),
      getConfidenceBucketedStats("lorentzian"),
      getSignalFunnel(),
      getGateRedundancy(),
    ])

    return NextResponse.json({
      confidenceBuckets: { logistic, lorentzian },
      funnel,
      redundancy,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}

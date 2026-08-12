import { NextResponse } from "next/server"
import { livePrices } from "@/lib/mexc/ws"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(livePrices)
}

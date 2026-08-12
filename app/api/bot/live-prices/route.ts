import { NextResponse } from "next/server"
import { livePrices } from "@/lib/mexc/ws"
import { getGridConfigs } from "@/lib/grid"
import { fetchTicker } from "@/lib/mexc/public"

export const dynamic = "force-dynamic"

const backfill: Record<string, { t: number; p: number }> = {}

export async function GET() {
  const out: Record<string, number> = { ...livePrices }
  try {
    const cfgs = await getGridConfigs()
    const missing = [...new Set(cfgs.filter(c => c.enabled && out[c.symbol] == null).map(c => c.symbol))].slice(0, 10)
    await Promise.all(missing.map(async (sym) => {
      const now = Date.now()
      const c = backfill[sym]
      if (c && now - c.t < 10000) { out[sym] = c.p; return }
      try {
        const t: any = await fetchTicker(sym)
        const p = t?.last ?? t?.lastPrice ?? t?.price ?? 0
        if (p > 0) { backfill[sym] = { t: now, p }; out[sym] = p }
      } catch {}
    }))
  } catch {}
  return NextResponse.json(out)
}

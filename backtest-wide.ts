// Wide-range grid for BANK flash moves (zero fees)
import { computeSnapshot } from "./lib/indicators"
import { detectVolatilitySurge } from "./lib/volatility-guard"

const SYMBOL = "BANK_USDT"
const TAKER_FEE = 0.0 // Zero fees!
const LEVELS = 25
const RANGE = 40 // 40% above and below current price
const PER_LEVEL = 200 // $200 per level

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchAll(symbol: string, hoursBack: number): Promise<Candle[]> {
  const endSec = Math.floor(Date.now() / 1000), startSec = endSec - hoursBack * 3600
  const all: Candle[] = []
  let fe = endSec
  while (true) {
    const fs = Math.max(startSec, fe - 2000 * 300)
    const u = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min5&start=${fs}&end=${fe}`
    const r = await fetch(u); const j = await r.json() as any
    if (!j.success || !j.data?.time?.length) break
    const { time, open, high, low, close, vol } = j.data
    for (let i = 0; i < time.length; i++) {
      if (time[i] >= startSec && time[i] <= endSec) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    }
    if (time[0] <= startSec || time.length < 100) break
    fe = time[0] - 300
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

async function main() {
  // Fetch 5-min candles for finer granularity during the spike
  const candles = await fetchAll(SYMBOL, 24)
  console.log(`${candles.length} BANK_USDT 5-min candles (24 hours)\n`)

  let gBuys: Array<{ price: number; qty: number }> = []
  let gSells: Array<{ price: number; qty: number; buyPrice: number }> = []
  let equity = 10000
  let trades = 0
  let totalPnl = 0
  let lastSetup = 0

  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close
    const high = candles[i].high
    const low = candles[i].low

    // Re-setup ladder every 4 hours or when empty
    if (gBuys.length === 0 || (i - lastSetup > 48)) {
      gBuys = []
      gSells = []
      const lower = price * (1 - RANGE / 100)
      const upper = price * (1 + RANGE / 100)
      const step = (upper - lower) / LEVELS
      
      for (let l = 0; l < LEVELS; l++) {
        const bp = lower + step * l
        if (bp <= 0) continue
        gBuys.push({ price: bp, qty: (PER_LEVEL * 2) / bp })
      }
      lastSetup = i
    }

    // Check buy fills — use LOW of candle (flash crash fills)
    for (const b of [...gBuys]) {
      if (low <= b.price) {
        gBuys = gBuys.filter(x => x !== b)
        const sp = b.price * 1.005 // 0.5% profit target
        gSells.push({ price: sp, qty: b.qty, buyPrice: b.price })
      }
    }

    // Check sell fills — use HIGH of candle (flash pump fills)
    for (const s of [...gSells]) {
      if (high >= s.price) {
        gSells = gSells.filter(x => x !== s)
        const gp = (s.price - s.buyPrice) * s.qty
        const fees = s.buyPrice * s.qty * TAKER_FEE + s.price * s.qty * TAKER_FEE
        const pnl = gp - fees
        trades++
        totalPnl += pnl
        equity += pnl
        const date = new Date(candles[i].time * 1000).toISOString().replace("T", " ").replace(".000Z", "")
        if (Math.abs(pnl) > 0.5) { // Only log significant trades
          console.log(`${date} ${s.buyPrice.toFixed(4)} → ${s.price.toFixed(4)} | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`)
        }
        gBuys.push({ price: s.buyPrice, qty: s.qty })
      }
    }
  }

  // Close remaining
  const lp = candles[candles.length - 1].close
  for (const s of gSells) {
    const gp = (lp - s.buyPrice) * s.qty
    const fees = s.buyPrice * s.qty * TAKER_FEE + lp * s.qty * TAKER_FEE
    totalPnl += gp - fees
    equity += gp - fees
  }

  console.log(`\n═══════════════════════════════════`)
  console.log(`  Wide Grid (${RANGE}% range, ${LEVELS} levels, $${PER_LEVEL}/level)`)
  console.log(`  Zero fees, 5-min candles, 24 hours`)
  console.log(`───────────────────────────────────`)
  console.log(`  Total trades:  ${trades}`)
  console.log(`  Total P&L:     ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`)
  console.log(`  Final equity:  ${equity.toFixed(2)} USDT`)
  console.log(`  Return:        ${((equity - 10000) / 10000 * 100).toFixed(1)}%`)
  console.log(`═══════════════════════════════════`)
}

main().catch(console.error)

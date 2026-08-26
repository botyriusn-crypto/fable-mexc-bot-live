// Phase B: Grid parameter sweep on top winners
const FEE = 0
const SPREAD: Record<string, number> = {
  BTC_USDT: .0001, ETH_USDT: .0001, SOL_USDT: .0002, AVAX_USDT: .0002, LINK_USDT: .0002,
}
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchAll(sym: string, days = 30): Promise<Candle[]> {
  const isec = 900, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, open, high, low, close, vol } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

interface Result { sym: string; spacing: number; depth: number; n: number; net: number; ret: number; maxInventory: number }
const results: Result[] = []

function grid(sym: string, c: Candle[], spacing: number, depth: number) {
  const sp = SPREAD[sym] ?? 0.001
  let equity = 10000, maxInv = 0, currentInv = 0
  let buys: { p: number; q: number }[] = [], sells: { p: number; q: number; bp: number }[] = []
  const fills: { notional: number; gross: number }[] = []
  
  for (let i = 200; i < c.length; i++) {
    const price = c[i].close
    if (!buys.length && !sells.length) {
      for (let l = 1; l <= depth; l++) {
        const bp = price * (1 - spacing / 100 * l)
        buys.push({ p: bp, q: 500 / bp })
      }
    }
    for (const b of [...buys]) {
      if (price <= b.p) {
        buys = buys.filter(x => x !== b)
        sells.push({ p: b.p * (1 + spacing / 100), q: b.q, bp: b.p })
        currentInv += b.p * b.q
      }
    }
    for (const s of [...sells]) {
      if (price >= s.p) {
        sells = sells.filter(x => x !== s)
        fills.push({ notional: s.p * s.q + s.bp * s.q, gross: (s.p - s.bp) * s.q })
        currentInv -= s.bp * s.q
        buys.push({ p: s.bp, q: s.q })
      }
    }
    maxInv = Math.max(maxInv, currentInv)
    
    const cost = fills.length > 0 ? fills[fills.length - 1].notional * sp : 0
    if (fills.length > 0) equity += fills[fills.length - 1].gross - cost
  }
  
  results.push({ sym, spacing, depth, n: fills.length, net: equity - 10000, ret: (equity - 10000) / 100, maxInventory: maxInv })
}

async function main() {
  const symbols = ["BTC_USDT", "SOL_USDT", "AVAX_USDT", "ETH_USDT", "LINK_USDT"]
  const spacings = [0.1, 0.15, 0.2, 0.25, 0.3]
  const depths = [3, 5, 7]
  
  for (const sym of symbols) {
    const c = await fetchAll(sym)
    if (c.length < 300) { console.log(`${sym}: not enough data`); continue }
    for (const spacing of spacings) {
      for (const depth of depths) {
        grid(sym, c, spacing, depth)
      }
    }
  }
  
  results.sort((a, b) => b.net - a.net)
  
  console.log("\nTop 20 configurations (30 days, 0 fees):")
  console.log(" symbol       | spacing | depth | trades | net PnL | return% | max inventory")
  for (const r of results.slice(0, 20)) {
    console.log(` ${r.sym.padEnd(12)} | ${r.spacing.toFixed(2).padStart(6)}% | ${String(r.depth).padStart(5)} | ${String(r.n).padStart(6)} | ${r.net.toFixed(1).padStart(7)} | ${r.ret.toFixed(2).padStart(7)} | $${r.maxInventory.toFixed(0).padStart(5)}`)
  }
  
  console.log("\n\nBest spacing per symbol:")
  const bestBySymbol: Record<string, Result> = {}
  for (const r of results) {
    if (!bestBySymbol[r.sym] || r.net > bestBySymbol[r.sym].net) bestBySymbol[r.sym] = r
  }
  for (const sym of Object.keys(bestBySymbol).sort()) {
    const r = bestBySymbol[sym]
    console.log(` ${sym.padEnd(12)} | spacing ${r.spacing.toFixed(2)}% | depth ${r.depth} | ${r.n} trades | +$${r.net.toFixed(1)} (${r.ret.toFixed(2)}%)`)
  }
}

main()

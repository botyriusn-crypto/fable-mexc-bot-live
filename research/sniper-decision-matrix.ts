import { detectSniper } from "../lib/sniper"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Trade { symbol: string; dir: "L" | "S"; r: number; win: boolean; confidence: number; reasonType: string }

function calcATR(candles: Candle[], period: number): number {
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close))
  }
  return sum / period
}
function buildSnap(candles: Candle[]) {
  const closes = candles.map(c => c.close); const n = closes.length
  let gains = 0, losses = 0
  for (let i = n - 14; i < n; i++) { const d = closes[i] - closes[i-1]; if (d > 0) gains += d; else losses -= d }
  const rsi = 100 - (100 / (1 + gains / Math.max(losses, 1e-9)))
  return { price: closes[n-1], atr: calcATR(candles, 14), adx: 25, emaFast: closes[n-1], emaSlow: closes[n-1], rsi, bb: { upper: 0, middle: 0, lower: 0 } } as any
}
function reasonType(r: string): string {
  if (r.includes("Sigma")) return "sigma"
  if (r.includes("sweep")) return "sweep"
  if (r.includes("funding")) return "funding"
  return "other"
}
async function fetchKlines(sym: string, days: number): Promise<Candle[]> {
  const isec = 300, es = Math.floor(Date.now()/1000), ss = es - days*86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000*isec)
    const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min5&start=${fs}&end=${fe}`)).json() as any
    if (!j.success || !j.data?.time?.length) break
    const { time, open, high, low, close, vol } = j.data
    for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    if (time[0] <= ss || time.length < 100) break
    fe = time[0] - isec
    await new Promise(r => setTimeout(r, 80))
  }
  all.sort((a,b) => a.time - b.time)
  return all.filter((c,i,a) => i === 0 || c.time !== a[i-1].time)
}
function runBacktest(candles: Candle[], sym: string): Trade[] {
  const trades: Trade[] = []; let last = -999
  for (let i = 200; i < candles.length - 288; i++) {
    if (i - last < 12) continue
    const window = candles.slice(Math.max(0, i - 200), i + 1)
    const sig = detectSniper(window, buildSnap(window), 0, { sigmaExtreme: 3.5, volumeSurgeMult: 2.0 })
    if (!sig.direction) continue
    last = i
    const entry = candles[i].close, sl = sig.stopLoss, tp = sig.takeProfit
    const stopDist = Math.abs(entry - sl); if (stopDist === 0) continue
    const dir: "L" | "S" = sig.direction === "long" ? "L" : "S"
    for (let j = i + 1; j < Math.min(i + 288, candles.length); j++) {
      const hitSl = dir === "L" ? candles[j].low <= sl : candles[j].high >= sl
      const hitTp = dir === "L" ? candles[j].high >= tp : candles[j].low <= tp
      if (hitSl) { trades.push({ symbol: sym, dir, r: -1, win: false, confidence: sig.confidence, reasonType: reasonType(sig.reason) }); break }
      if (hitTp) { trades.push({ symbol: sym, dir, r: 4, win: true, confidence: sig.confidence, reasonType: reasonType(sig.reason) }); break }
    }
  }
  return trades
}
function stats(trades: Trade[]) {
  const n = trades.length
  const wins = trades.filter(t => t.win).length
  const totalR = trades.reduce((s,t) => s + t.r, 0)
  const gw = trades.filter(t=>t.win).reduce((s,t)=>s+t.r,0)
  const gl = Math.abs(trades.filter(t=>!t.win).reduce((s,t)=>s+t.r,0))
  return { n, wr: n ? wins/n*100 : 0, avgR: n ? totalR/n : 0, totalR, pf: gl > 0 ? gw/gl : (gw > 0 ? 99 : 0) }
}

async function main() {
  console.log("=== Sniper Decision Matrix: Confidence × Direction ===\n")
  const res = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const json = await res.json() as any
  const mega = new Set(["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT","DOGE_USDT","ADA_USDT","AVAX_USDT","LINK_USDT"])
  const symbols = json.data
    .filter((t:any)=>t.symbol.endsWith("_USDT") && !mega.has(t.symbol) && !t.symbol.includes("3L") && !t.symbol.includes("3S") && !t.symbol.includes("STOCK"))
    .filter((t:any)=>t.amount24>=10_000_000 && t.amount24<=200_000_000)
    .sort((a:any,b:any)=>b.amount24-a.amount24).slice(0,20).map((t:any)=>t.symbol)

  const all: Trade[] = []
  for (const sym of symbols) {
    process.stdout.write(`${sym}... `)
    const c = await fetchKlines(sym, 30)
    if (c.length < 500) { console.log("skip"); continue }
    all.push(...runBacktest(c, sym))
    console.log("done")
  }

  console.log("\n" + "=".repeat(82))
  console.log("CONFIDENCE × DIRECTION MATRIX (30 days, 20 mid-caps)")
  console.log("=".repeat(82))
  console.log(`${"Config".padEnd(26)} | ${"Trades".padEnd(6)} | ${"WR".padEnd(7)} | ${"AvgR".padEnd(8)} | ${"TotalR".padEnd(8)} | ${"PF".padEnd(6)} | ${"/day".padEnd(5)}`)
  console.log("-".repeat(82))

  const configs = [
    { name: "CURRENT (conf 0.6, both)", conf: 0.6, dir: "both" },
    { name: "conf 0.7, both", conf: 0.7, dir: "both" },
    { name: "conf 0.8, both", conf: 0.8, dir: "both" },
    { name: "conf 0.6, LONG only", conf: 0.6, dir: "L" },
    { name: "conf 0.7, LONG only", conf: 0.7, dir: "L" },
    { name: "conf 0.8, LONG only", conf: 0.8, dir: "L" },
    { name: "conf 0.8, SHORT only", conf: 0.8, dir: "S" },
  ]

  for (const cfg of configs) {
    const f = all.filter(t => t.confidence >= cfg.conf && (cfg.dir === "both" || t.dir === cfg.dir))
    const s = stats(f)
    const marker = s.totalR > 0 && s.n >= 20 ? "  ★" : ""
    console.log(`${cfg.name.padEnd(26)} | ${s.n.toString().padStart(6)} | ${(s.wr.toFixed(1)+"%").padStart(7)} | ${s.avgR.toFixed(3).padStart(8)} | ${s.totalR.toFixed(1).padStart(8)} | ${s.pf.toFixed(2).padStart(6)} | ${(s.n/30).toFixed(1).padStart(5)}${marker}`)
  }

  // Reason type breakdown for the best config
  console.log("\n" + "=".repeat(82))
  console.log("REASON TYPE BREAKDOWN (conf 0.8, both directions)")
  console.log("=".repeat(82))
  const f08 = all.filter(t => t.confidence >= 0.8)
  for (const rt of ["sweep", "sigma", "funding", "other"]) {
    const s = stats(f08.filter(t => t.reasonType === rt))
    if (s.n === 0) continue
    console.log(`${rt.padEnd(10)} | ${s.n.toString().padStart(6)} trades | WR ${(s.wr.toFixed(1)+"%").padStart(7)} | AvgR ${s.avgR.toFixed(3).padStart(8)} | TotalR ${s.totalR.toFixed(1).padStart(8)}`)
  }

  // Recommendation
  console.log("\n" + "=".repeat(82))
  console.log("RECOMMENDATION")
  console.log("=".repeat(82))
  const best = configs.map(cfg => ({ cfg, s: stats(all.filter(t => t.confidence >= cfg.conf && (cfg.dir === "both" || t.dir === cfg.dir))) }))
    .filter(x => x.s.n >= 20)
    .sort((a,b) => b.s.totalR - a.s.totalR)[0]
  if (best) {
    console.log(`Best config: ${best.cfg.name}`)
    console.log(`  ${best.s.n} trades, ${best.s.wr.toFixed(1)}% WR, ${best.s.avgR.toFixed(3)} avg R, ${best.s.totalR.toFixed(1)} total R, PF ${best.s.pf.toFixed(2)}`)
  }
}
main().catch(console.error)

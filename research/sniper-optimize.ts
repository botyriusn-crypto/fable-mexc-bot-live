import { detectSniper } from "../lib/sniper"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Trade { symbol: string; dir: string; entry: number; exit: number; r: number; win: boolean; bars: number; confidence: number; reason: string }

function calcATR(candles: Candle[], period: number): number {
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
    sum += tr
  }
  return sum / period
}

function buildSnap(candles: Candle[]) {
  const closes = candles.map(c => c.close)
  const n = closes.length
  const atrVal = calcATR(candles, 14)
  let gains = 0, losses = 0
  for (let i = n - 14; i < n; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  const rs = gains / Math.max(losses, 1e-9)
  const rsiVal = 100 - (100 / (1 + rs))
  return { price: closes[n - 1], atr: atrVal, adx: 25, emaFast: closes[n - 1], emaSlow: closes[n - 1], rsi: rsiVal, bb: { upper: 0, middle: 0, lower: 0 } } as any
}

async function fetchKlines(sym: string, days: number): Promise<Candle[]> {
  const isec = 300, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min5&start=${fs}&end=${fe}`)).json() as any
    if (!j.success || !j.data?.time?.length) break
    const { time, open, high, low, close, vol } = j.data
    for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    if (time[0] <= ss || time.length < 100) break
    fe = time[0] - isec
    await new Promise(r => setTimeout(r, 80))
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

function runBacktest(candles: Candle[], sym: string): Trade[] {
  const trades: Trade[] = []
  let lastSignalBar = -999

  for (let i = 200; i < candles.length - 288; i++) {
    if (i - lastSignalBar < 12) continue
    const window = candles.slice(Math.max(0, i - 200), i + 1)
    const snap = buildSnap(window)
    const sig = detectSniper(window, snap, 0, { sigmaExtreme: 3.5, volumeSurgeMult: 2.0 })
    if (!sig.direction) continue

    lastSignalBar = i
    const entry = candles[i].close
    const sl = sig.stopLoss
    const tp = sig.takeProfit
    const stopDist = Math.abs(entry - sl)
    if (stopDist === 0) continue

    let resolved = false
    for (let j = i + 1; j < Math.min(i + 288, candles.length); j++) {
      if (sig.direction === "long") {
        if (candles[j].low <= sl) { trades.push({ symbol: sym, dir: "L", entry, exit: sl, r: -1, win: false, bars: j - i, confidence: sig.confidence, reason: sig.reason }); resolved = true; break }
        if (candles[j].high >= tp) { trades.push({ symbol: sym, dir: "L", entry, exit: tp, r: (tp - entry) / stopDist, win: true, bars: j - i, confidence: sig.confidence, reason: sig.reason }); resolved = true; break }
      } else {
        if (candles[j].high >= sl) { trades.push({ symbol: sym, dir: "S", entry, exit: sl, r: -1, win: false, bars: j - i, confidence: sig.confidence, reason: sig.reason }); resolved = true; break }
        if (candles[j].low <= tp) { trades.push({ symbol: sym, dir: "S", entry, exit: tp, r: (entry - tp) / stopDist, win: true, bars: j - i, confidence: sig.confidence, reason: sig.reason }); resolved = true; break }
      }
    }
    if (!resolved) {
      const exit = candles[Math.min(i + 287, candles.length - 1)].close
      const r = sig.direction === "long" ? (exit - entry) / stopDist : (entry - exit) / stopDist
      trades.push({ symbol: sym, dir: sig.direction === "long" ? "L" : "S", entry, exit, r, win: r > 0, bars: 288, confidence: sig.confidence, reason: sig.reason })
    }
  }
  return trades
}

async function main() {
  console.log("=== Sniper Signal Optimization Analysis ===\n")
  
  const res = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const json = await res.json() as any
  const megaCaps = new Set(["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT", "XRP_USDT", "DOGE_USDT", "ADA_USDT", "AVAX_USDT", "LINK_USDT"])
  const symbols = json.data
    .filter((t: any) => t.symbol.endsWith("_USDT") && !megaCaps.has(t.symbol))
    .filter((t: any) => !t.symbol.includes("3L") && !t.symbol.includes("3S") && !t.symbol.includes("STOCK"))
    .filter((t: any) => t.amount24 >= 10_000_000 && t.amount24 <= 200_000_000)
    .sort((a: any, b: any) => b.amount24 - a.amount24)
    .slice(0, 20)
    .map((t: any) => t.symbol)

  const allTrades: Trade[] = []

  for (const sym of symbols) {
    process.stdout.write(`${sym}... `)
    const candles = await fetchKlines(sym, 30)
    if (candles.length < 500) { console.log("skip"); continue }
    const trades = runBacktest(candles, sym)
    allTrades.push(...trades)
    console.log(`${trades.length} trades`)
  }

  console.log("\n" + "=".repeat(80))
  console.log("=== 1. CONFIDENCE THRESHOLD SWEEP ===")
  console.log("=".repeat(80))
  console.log(`${"Threshold".padEnd(12)} | ${"Trades".padEnd(7)} | ${"WR".padEnd(7)} | ${"Avg R".padEnd(8)} | ${"Total R".padEnd(9)} | ${"PF".padEnd(6)}`)
  console.log("-".repeat(60))

  for (const thresh of [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const filtered = allTrades.filter(t => t.confidence >= thresh)
    const wins = filtered.filter(t => t.win).length
    const wr = filtered.length > 0 ? (wins / filtered.length * 100) : 0
    const totalR = filtered.reduce((s, t) => s + t.r, 0)
    const avgR = filtered.length > 0 ? totalR / filtered.length : 0
    const grossWin = filtered.filter(t => t.win).reduce((s, t) => s + t.r, 0)
    const grossLoss = Math.abs(filtered.filter(t => !t.win).reduce((s, t) => s + t.r, 0))
    const pf = grossLoss > 0 ? (grossWin / grossLoss) : 0
    console.log(`${(">=" + thresh.toFixed(1)).padEnd(12)} | ${filtered.length.toString().padStart(7)} | ${(wr.toFixed(1) + "%").padStart(7)} | ${avgR.toFixed(3).padStart(8)} | ${totalR.toFixed(1).padStart(9)} | ${pf.toFixed(2).padStart(6)}`)
  }

  console.log("\n" + "=".repeat(80))
  console.log("=== 2. DIRECTION ANALYSIS ===")
  console.log("=".repeat(80))
  
  const longs = allTrades.filter(t => t.dir === "L")
  const shorts = allTrades.filter(t => t.dir === "S")
  const longWR = longs.length > 0 ? (longs.filter(t => t.win).length / longs.length * 100) : 0
  const shortWR = shorts.length > 0 ? (shorts.filter(t => t.win).length / shorts.length * 100) : 0
  const longR = longs.reduce((s, t) => s + t.r, 0)
  const shortR = shorts.reduce((s, t) => s + t.r, 0)
  console.log(`Long:  ${longs.length} trades, ${longWR.toFixed(1)}% WR, ${longR.toFixed(1)} R`)
  console.log(`Short: ${shorts.length} trades, ${shortWR.toFixed(1)}% WR, ${shortR.toFixed(1)} R`)

  console.log("\n" + "=".repeat(80))
  console.log("=== 3. REASON BREAKDOWN ===")
  console.log("=".repeat(80))
  
  const reasons = new Map<string, Trade[]>()
  for (const t of allTrades) {
    const key = t.reason || "unknown"
    if (!reasons.has(key)) reasons.set(key, [])
    reasons.get(key)!.push(t)
  }
  
  console.log(`${"Reason".padEnd(40)} | ${"N".padEnd(5)} | ${"WR".padEnd(7)} | ${"Avg R".padEnd(8)} | ${"Total R".padEnd(8)}`)
  console.log("-".repeat(75))
  for (const [reason, trades] of [...reasons.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.r, 0) - a[1].reduce((s, t) => s + t.r, 0))) {
    const wins = trades.filter(t => t.win).length
    const wr = (wins / trades.length * 100)
    const totalR = trades.reduce((s, t) => s + t.r, 0)
    const avgR = totalR / trades.length
    console.log(`${reason.substring(0, 40).padEnd(40)} | ${trades.length.toString().padStart(5)} | ${(wr.toFixed(1) + "%").padStart(7)} | ${avgR.toFixed(3).padStart(8)} | ${totalR.toFixed(1).padStart(8)}`)
  }

  console.log("\n" + "=".repeat(80))
  console.log("=== 4. BARS TO EXIT (holding time) ===")
  console.log("=".repeat(80))
  
  const winners = allTrades.filter(t => t.win)
  const losers = allTrades.filter(t => !t.win)
  console.log(`Winners avg bars: ${winners.length > 0 ? (winners.reduce((s,t) => s+t.bars, 0) / winners.length).toFixed(1) : 0} (${(winners.length > 0 ? winners.reduce((s,t) => s+t.bars, 0) / winners.length * 5 / 60 : 0).toFixed(1)} hours)`)
  console.log(`Losers avg bars:  ${losers.length > 0 ? (losers.reduce((s,t) => s+t.bars, 0) / losers.length).toFixed(1) : 0} (${(losers.length > 0 ? losers.reduce((s,t) => s+t.bars, 0) / losers.length * 5 / 60 : 0).toFixed(1)} hours)`)

  console.log("\n" + "=".repeat(80))
  console.log("=== 5. OPTIMAL CONFIGURATION ===")
  console.log("=".repeat(80))
  
  // Find the best confidence threshold (highest total R with >= 10 trades)
  let bestThresh = 0, bestR = -Infinity
  for (const thresh of [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const filtered = allTrades.filter(t => t.confidence >= thresh)
    if (filtered.length < 10) continue
    const totalR = filtered.reduce((s, t) => s + t.r, 0)
    if (totalR > bestR) { bestR = totalR; bestThresh = thresh }
  }
  
  const optimal = allTrades.filter(t => t.confidence >= bestThresh)
  const optWins = optimal.filter(t => t.win).length
  const optWR = optimal.length > 0 ? (optWins / optimal.length * 100) : 0
  const optAvgR = optimal.length > 0 ? optimal.reduce((s, t) => s + t.r, 0) / optimal.length : 0
  
  console.log(`Best confidence floor: >= ${bestThresh.toFixed(1)}`)
  console.log(`  Trades: ${optimal.length}`)
  console.log(`  Win Rate: ${optWR.toFixed(1)}%`)
  console.log(`  Avg R: ${optAvgR.toFixed(3)}`)
  console.log(`  Total R (30d): ${bestR.toFixed(1)}`)
  console.log(`  Trades/day: ${(optimal.length / 30).toFixed(1)}`)
}

main().catch(console.error)

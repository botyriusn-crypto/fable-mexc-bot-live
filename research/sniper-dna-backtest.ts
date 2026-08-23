import { detectSniper, SNIPER_PARAMS } from "../lib/sniper"
import { atr, adx, ema } from "../lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Signal { time: number; direction: "long" | "short"; entry: number; sl: number; tp: number; confidence: number }
interface Trade { symbol: string; direction: string; entry: number; exit: number; r: number; win: boolean; bars: number }

const KNOWN: [string, number][] = [
  ["WLD_USDT", 1.831], ["LINK_USDT", 1.066], ["SUI_USDT", 0.576], ["DOGE_USDT", 0.329],
  ["AVAX_USDT", 0.239], ["HYPE_USDT", 0.169], ["BASED_USDT", -0.046], ["ORDI_USDT", -0.041],
  ["ZEN_USDT", -0.510], ["TAO_USDT", -0.675], ["SEI_USDT", -0.678], ["PEPE_USDT", -0.844],
]

async function fetchAll(sym: string, days = 60): Promise<Candle[]> {
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
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

function checkDNA(candles: Candle[]): boolean {
  const closes = candles.map(k => k.close)
  const highs = candles.map(k => k.high)
  const lows = candles.map(k => k.low)
  const n = closes.length
  const lastClose = closes[n - 1]
  
  let trSum = 0
  for (let i = n - 14; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    trSum += tr
  }
  const atrPct = (trSum / 14 / lastClose) * 100
  
  let sigEvents = 0, sigRevert = 0
  for (let i = 100; i < n - 6; i++) {
    let m = 0; const rets: number[] = []
    for (let j = i - 100; j < i; j++) rets.push((closes[j + 1] - closes[j]) / closes[j])
    m = rets.reduce((a, b) => a + b, 0) / 100
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / 100)
    const r = (closes[i] - closes[i - 1]) / closes[i - 1]
    if (sd > 0 && Math.abs(r) > 3.5 * sd) {
      sigEvents++
      const move = closes[i] - closes[i - 1], back = closes[i + 6] - closes[i]
      if (Math.sign(back) === -Math.sign(move) && Math.abs(back) >= 0.5 * Math.abs(move)) sigRevert++
    }
  }
  const sigmaRevertRate = sigEvents > 0 ? (sigRevert / sigEvents) * 100 : 50
  
  return atrPct >= 0.3 && atrPct <= 0.7 && sigmaRevertRate >= 15 && sigmaRevertRate <= 32
}

function runBacktest(candles: Candle[], sym: string, useDNA: boolean): Trade[] {
  const trades: Trade[] = []
  const signals: Signal[] = []
  const riskPct = SNIPER_PARAMS.minStopPct ?? 1.5
  
  for (let i = 200; i < candles.length - 50; i += 3) {
    const window = candles.slice(i - 200, i)
    const atrArr = atr(window, 14)
    const adxArr = adx(window, 14)
    const emaF = ema(window.map(c => c.close), 9)
    const emaS = ema(window.map(c => c.close), 21)
    const snap = {
      price: candles[i - 1].close,
      atr: atrArr[atrArr.length - 1],
      adx: adxArr[adxArr.length - 1],
      emaFast: emaF[emaF.length - 1],
      emaSlow: emaS[emaS.length - 1],
      rsi: 50, bb: { upper: 0, middle: 0, lower: 0 },
    } as any
    
    if (useDNA && !checkDNA(window)) continue
    
    const sig = detectSniper(window, snap, 0, { sigmaExtreme: 3.5, volumeSurgeMult: 2.0 })
    if (!sig.direction) continue
    
    if (signals.length > 0 && i - signals[signals.length - 1].time < 10) continue
    
    const entry = candles[i].close
    const stopDist = entry * (riskPct / 100)
    const sl = sig.direction === "long" ? entry - stopDist : entry + stopDist
    const tp = sig.direction === "long" ? entry + stopDist * 4 : entry - stopDist * 4
    
    signals.push({ time: i, direction: sig.direction, entry, sl, tp, confidence: sig.confidence })
    
    let resolved = false
    for (let j = i; j < Math.min(i + 288, candles.length); j++) {
      if (sig.direction === "long") {
        if (candles[j].low <= sl) {
          trades.push({ symbol: sym, direction: "long", entry, exit: sl, r: -1, win: false, bars: j - i })
          resolved = true; break
        }
        if (candles[j].high >= tp) {
          trades.push({ symbol: sym, direction: "long", entry, exit: tp, r: 4, win: true, bars: j - i })
          resolved = true; break
        }
      } else {
        if (candles[j].high >= sl) {
          trades.push({ symbol: sym, direction: "short", entry, exit: sl, r: -1, win: false, bars: j - i })
          resolved = true; break
        }
        if (candles[j].low <= tp) {
          trades.push({ symbol: sym, direction: "short", entry, exit: tp, r: 4, win: true, bars: j - i })
          resolved = true; break
        }
      }
    }
    if (!resolved) {
      const exit = candles[Math.min(i + 287, candles.length - 1)].close
      const r = sig.direction === "long" ? (exit - entry) / stopDist : (entry - exit) / stopDist
      trades.push({ symbol: sym, direction: sig.direction, entry, exit, r, win: r > 0, bars: 288 })
    }
  }
  
  return trades
}

async function main() {
  console.log("=== Sniper DNA Backtest: 60 days, 12 symbols ===\n")
  
  const withDNA: Trade[] = []
  const withoutDNA: Trade[] = []
  
  for (const [sym, knownAvgR] of KNOWN) {
    console.log(`Fetching ${sym}...`)
    const candles = await fetchAll(sym, 60)
    if (candles.length < 500) { console.log(`  ⚠️  ${sym}: insufficient data (${candles.length} bars)`); continue }
    
    const tradesWith = runBacktest(candles, sym, true)
    const tradesWithout = runBacktest(candles, sym, false)
    
    withDNA.push(...tradesWith)
    withoutDNA.push(...tradesWithout)
    
    const winWith = tradesWith.filter(t => t.win).length
    const winWithout = tradesWithout.filter(t => t.win).length
    const avgRWith = tradesWith.length > 0 ? tradesWith.reduce((s, t) => s + t.r, 0) / tradesWith.length : 0
    const avgRWithout = tradesWithout.length > 0 ? tradesWithout.reduce((s, t) => s + t.r, 0) / tradesWithout.length : 0
    
    console.log(`  ${sym.padEnd(12)} | DNA: ${tradesWith.length} trades, ${winWith} wins, avg R ${avgRWith.toFixed(2)}`)
    console.log(`  ${"".padEnd(12)} | Raw: ${tradesWithout.length} trades, ${winWithout} wins, avg R ${avgRWithout.toFixed(2)}`)
  }
  
  console.log("\n=== AGGREGATE RESULTS ===")
  
  const winDNA = withDNA.filter(t => t.win).length
  const winNoDNA = withoutDNA.filter(t => t.win).length
  const wrDNA = withDNA.length > 0 ? (winDNA / withDNA.length * 100) : 0
  const wrNoDNA = withoutDNA.length > 0 ? (winNoDNA / withoutDNA.length * 100) : 0
  const avgR_DNA = withDNA.length > 0 ? withDNA.reduce((s, t) => s + t.r, 0) / withDNA.length : 0
  const avgR_NoDNA = withoutDNA.length > 0 ? withoutDNA.reduce((s, t) => s + t.r, 0) / withoutDNA.length : 0
  const totalR_DNA = withDNA.reduce((s, t) => s + t.r, 0)
  const totalR_NoDNA = withoutDNA.reduce((s, t) => s + t.r, 0)
  
  console.log(`\n${"Metric".padEnd(25)} | ${"Without DNA".padEnd(15)} | ${"With DNA".padEnd(15)} | ${"Δ".padEnd(10)}`)
  console.log(`${"-".repeat(70)}`)
  console.log(`${"Total signals".padEnd(25)} | ${withoutDNA.length.toString().padStart(15)} | ${withDNA.length.toString().padStart(15)} | fewer`)
  console.log(`${"Win rate".padEnd(25)} | ${(wrNoDNA.toFixed(1) + "%").padStart(15)} | ${(wrDNA.toFixed(1) + "%").padStart(15)} | ${((wrDNA - wrNoDNA) >= 0 ? "+" : "") + (wrDNA - wrNoDNA).toFixed(1)} pp`)
  console.log(`${"Avg R per trade".padEnd(25)} | ${avgR_NoDNA.toFixed(3).padStart(15)} | ${avgR_DNA.toFixed(3).padStart(15)} | ${((avgR_DNA - avgR_NoDNA) >= 0 ? "+" : "") + (avgR_DNA - avgR_NoDNA).toFixed(3)}`)
  console.log(`${"Total R (60d)".padEnd(25)} | ${totalR_NoDNA.toFixed(1).padStart(15)} | ${totalR_DNA.toFixed(1).padStart(15)} | ${((totalR_DNA - totalR_NoDNA) >= 0 ? "+" : "") + (totalR_DNA - totalR_NoDNA).toFixed(1)}`)
  
  console.log("\n=== PER-SYMBOL BREAKDOWN ===")
  console.log(`${"Symbol".padEnd(12)} | ${"Known R".padEnd(8)} | ${"Raw".padEnd(5)} | ${"DNA".padEnd(5)} | ${"Raw avgR".padEnd(9)} | ${"DNA avgR".padEnd(9)} | ${"Δ".padEnd(8)}`)
  console.log(`${"-".repeat(75)}`)
  
  for (const [sym, knownR] of KNOWN) {
    const rawTrades = withoutDNA.filter(t => t.symbol === sym)
    const dnaTrades = withDNA.filter(t => t.symbol === sym)
    const rawAvg = rawTrades.length > 0 ? rawTrades.reduce((s, t) => s + t.r, 0) / rawTrades.length : 0
    const dnaAvg = dnaTrades.length > 0 ? dnaTrades.reduce((s, t) => s + t.r, 0) / dnaTrades.length : 0
    const delta = dnaAvg - rawAvg
    console.log(`${sym.padEnd(12)} | ${knownR.toFixed(3).padStart(7)} | ${rawTrades.length.toString().padStart(5)} | ${dnaTrades.length.toString().padStart(5)} | ${rawAvg.toFixed(3).padStart(9)} | ${dnaAvg.toFixed(3).padStart(9)} | ${((delta >= 0 ? "+" : "") + delta.toFixed(3)).padStart(8)}`)
  }
  
  console.log("\n=== KEY FINDINGS ===")
  const losers = ["PEPE_USDT", "ZEN_USDT", "TAO_USDT", "SEI_USDT", "BASED_USDT", "ORDI_USDT"]
  const winners = ["WLD_USDT", "LINK_USDT", "SUI_USDT", "DOGE_USDT", "AVAX_USDT", "HYPE_USDT"]
  
  const loserRaw = withoutDNA.filter(t => losers.includes(t.symbol))
  const loserDNA = withDNA.filter(t => losers.includes(t.symbol))
  const winnerRaw = withoutDNA.filter(t => winners.includes(t.symbol))
  const winnerDNA = withDNA.filter(t => winners.includes(t.symbol))
  
  console.log(`Losers (known negative R):`)
  console.log(`  Raw: ${loserRaw.length} trades, avg R ${(loserRaw.length > 0 ? loserRaw.reduce((s, t) => s + t.r, 0) / loserRaw.length : 0).toFixed(3)}`)
  console.log(`  DNA: ${loserDNA.length} trades, avg R ${(loserDNA.length > 0 ? loserDNA.reduce((s, t) => s + t.r, 0) / loserDNA.length : 0).toFixed(3)}`)
  console.log(`  Blocked: ${loserRaw.length - loserDNA.length} trades (${loserRaw.length > 0 ? ((1 - loserDNA.length / loserRaw.length) * 100).toFixed(1) : 0}% reduction)`)
  
  console.log(`Winners (known positive R):`)
  console.log(`  Raw: ${winnerRaw.length} trades, avg R ${(winnerRaw.length > 0 ? winnerRaw.reduce((s, t) => s + t.r, 0) / winnerRaw.length : 0).toFixed(3)}`)
  console.log(`  DNA: ${winnerDNA.length} trades, avg R ${(winnerDNA.length > 0 ? winnerDNA.reduce((s, t) => s + t.r, 0) / winnerDNA.length : 0).toFixed(3)}`)
  console.log(`  Retained: ${winnerDNA.length}/${winnerRaw.length} trades (${winnerRaw.length > 0 ? (winnerDNA.length / winnerRaw.length * 100).toFixed(1) : 0}% kept)`)
}

main().catch(console.error)

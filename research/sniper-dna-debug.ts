import { atr } from "../lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

const KNOWN = [
  ["WLD_USDT", 1.831], ["LINK_USDT", 1.066], ["SUI_USDT", 0.576],
  ["ZEN_USDT", -0.510], ["PEPE_USDT", -0.844]
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

function analyzeDNA(candles: Candle[]): { atrPct: number; sigmaRevertRate: number; passes: boolean } {
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
  
  const passes = atrPct >= 0.3 && atrPct <= 0.7 && sigmaRevertRate >= 15 && sigmaRevertRate <= 32
  
  return { atrPct, sigmaRevertRate, passes }
}

async function main() {
  console.log("=== DNA Filter Debug: Sample Windows ===\n")
  
  for (const [sym] of KNOWN) {
    console.log(`\n${sym}:`)
    const candles = await fetchAll(sym, 60)
    if (candles.length < 500) { console.log(`  Insufficient data`); continue }
    
    let passed = 0, failed = 0
    const samples: { atrPct: number; sigmaRevertRate: number; passes: boolean }[] = []
    
    // Sample 20 windows across the 60 days
    for (let i = 0; i < 20; i++) {
      const windowStart = 200 + Math.floor((candles.length - 250) * (i / 20))
      const window = candles.slice(windowStart - 200, windowStart)
      const result = analyzeDNA(window)
      
      if (result.passes) passed++
      else failed++
      
      if (samples.length < 5) samples.push(result)
    }
    
    console.log(`  Windows checked: ${passed + failed}`)
    console.log(`  Passed: ${passed} (${(passed / (passed + failed) * 100).toFixed(1)}%)`)
    console.log(`  Failed: ${failed} (${(failed / (passed + failed) * 100).toFixed(1)}%)`)
    
    console.log(`\n  Sample values:`)
    samples.forEach((s, i) => {
      const atrOk = s.atrPct >= 0.3 && s.atrPct <= 0.7
      const sigOk = s.sigmaRevertRate >= 15 && s.sigmaRevertRate <= 32
      console.log(`    ${i + 1}. ATR=${s.atrPct.toFixed(2)}% ${atrOk ? "✓" : "✗"} | σRev=${s.sigmaRevertRate.toFixed(1)}% ${sigOk ? "✓" : "✗"} | ${s.passes ? "PASS" : "FAIL"}`)
    })
  }
  
  console.log("\n=== DNA Filter Thresholds ===")
  console.log("ATR%: 0.3% - 0.7%")
  console.log("σRev%: 15% - 32%")
  console.log("\nIf most windows fall outside these ranges, the filter is too strict.")
}

main().catch(console.error)

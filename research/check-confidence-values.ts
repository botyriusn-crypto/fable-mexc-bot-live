import { detectSniper } from "../lib/sniper"

async function fetchKlines(sym: string, days: number) {
  const isec = 300, es = Math.floor(Date.now()/1000), ss = es - days*86400
  const all: any[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000*isec)
    const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min5&start=${fs}&end=${fe}`)).json() as any
    if (!j.success || !j.data?.time?.length) break
    const { time, open, high, low, close, vol } = j.data
    for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    if (time[0] <= ss || time.length < 100) break
    fe = time[0] - isec
  }
  all.sort((a:any,b:any) => a.time - b.time)
  return all.filter((c:any,i:any,a:any) => i === 0 || c.time !== a[i-1].time)
}

function buildSnap(candles: any[]) {
  const closes = candles.map((c:any) => c.close)
  const n = closes.length
  let trSum = 0
  for (let i = n - 14; i < n; i++) {
    trSum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close))
  }
  const atr = trSum / 14
  let gains = 0, losses = 0
  for (let i = n - 14; i < n; i++) { const d = closes[i] - closes[i-1]; if (d > 0) gains += d; else losses -= d }
  const rsi = 100 - (100 / (1 + gains / Math.max(losses, 1e-9)))
  return { price: closes[n-1], atr, adx: 25, emaFast: closes[n-1], emaSlow: closes[n-1], rsi, bb: { upper: 0, middle: 0, lower: 0 } } as any
}

async function main() {
  console.log("=== Recent Signal Confidence Values (last 7 days) ===\n")
  
  const symbols = ['BEAT_USDT', 'TUT_USDT', 'ZRO_USDT', 'SOXL_USDT', 'WLFI_USDT', 'NEAR_USDT']
  
  for (const sym of symbols) {
    console.log(`\n${sym}:`)
    const candles = await fetchKlines(sym, 7)
    if (candles.length < 200) continue
    
    let signalCount = 0
    const confidences: number[] = []
    
    // Check last 500 bars
    for (let i = candles.length - 500; i < candles.length - 10; i++) {
      const window = candles.slice(Math.max(0, i - 200), i + 1)
      const sig = detectSniper(window, buildSnap(window), 0, { sigmaExtreme: 3.5, volumeSurgeMult: 2.0 })
      if (sig.direction) {
        signalCount++
        confidences.push(sig.confidence)
      }
    }
    
    if (confidences.length > 0) {
      const avg = confidences.reduce((a,b) => a+b, 0) / confidences.length
      const min = Math.min(...confidences)
      const max = Math.max(...confidences)
      const above07 = confidences.filter(c => c >= 0.7).length
      console.log(`  Signals: ${signalCount}`)
      console.log(`  Confidence: avg=${avg.toFixed(2)}, min=${min.toFixed(2)}, max=${max.toFixed(2)}`)
      console.log(`  Above 0.7 threshold: ${above07}/${signalCount} (${(above07/signalCount*100).toFixed(1)}%)`)
    } else {
      console.log(`  No signals in last 7 days`)
    }
  }
}

main().catch(console.error)

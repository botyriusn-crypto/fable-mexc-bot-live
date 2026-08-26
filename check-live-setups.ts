// Check if the market is actually producing sniper setups right now
import { atr } from "./lib/indicators"

async function main() {
  console.log("=== Live Market Setup Check (Sunday Night) ===\n")
  
  const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const tickerJson = await tickerRes.json() as any
  const tickers = tickerJson.data
    .filter((t: any) => t.symbol.endsWith("_USDT") && t.amount24 > 10_000_000)
    .sort((a: any, b: any) => b.amount24 - a.amount24)
    .slice(0, 15)

  console.log("Symbol      | Vol($M) | DNA Pass? | Sweeps (24h) | Sigma Events | Verdict")
  console.log("------------|---------|-----------|--------------|--------------|--------")

  for (const t of tickers) {
    const end = Math.floor(Date.now() / 1000)
    const start = end - 7 * 86400
    const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min5&start=${start}&end=${end}`)
    const json = await res.json() as any
    if (!json.success) continue
    
    const candles = json.data.time.map((time: number, i: number) => ({
      time, open: json.data.open[i], high: json.data.high[i], low: json.data.low[i], close: json.data.close[i]
    }))
    
    // DNA Check
    const n = candles.length
    const closes = candles.map((k: any) => k.close)
    const highs = candles.map((k: any) => k.high)
    const lows = candles.map((k: any) => k.low)
    const lastClose = closes[n - 1]
    let trSum = 0
    for (let i = n - 14; i < n; i++) trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    const atrPct = (trSum / 14 / lastClose) * 100
    
    let sigEvents = 0, sigRevert = 0
    for (let i = 100; i < n - 6; i++) {
      let m = 0; const rets: number[] = []
      for (let j = i - 100; j < i; j++) rets.push((closes[j + 1] - closes[j]) / closes[j])
      m = rets.reduce((a: number, b: number) => a + b, 0) / 100
      const sd = Math.sqrt(rets.reduce((a: number, b: number) => a + (b - m) ** 2, 0) / 100)
      const r = (closes[i] - closes[i - 1]) / closes[i - 1]
      if (sd > 0 && Math.abs(r) > 3.5 * sd) {
        sigEvents++
        const move = closes[i] - closes[i - 1], back = closes[i + 6] - closes[i]
        if (Math.sign(back) === -Math.sign(move) && Math.abs(back) >= 0.5 * Math.abs(move)) sigRevert++
      }
    }
    const sigmaRevertRate = sigEvents > 0 ? (sigRevert / sigEvents) * 100 : 50
    const dnaPass = atrPct >= 0.3 && atrPct <= 0.7 && sigmaRevertRate >= 15 && sigmaRevertRate <= 32

    // Count recent sweeps (last 24 hours = 288 candles)
    let sweeps = 0
    for (let i = n - 288; i < n; i++) {
      if (i < 21) continue
      let ph = -Infinity, pl = Infinity
      for (let j = i - 20; j < i; j++) { ph = Math.max(ph, highs[j]); pl = Math.min(pl, lows[j]) }
      if (highs[i] > ph && closes[i] < ph) sweeps++
      if (lows[i] < pl && closes[i] > pl) sweeps++
    }

    // Recent sigma events (last 24h)
    let recentSigma = 0
    for (let i = n - 288; i < n; i++) {
      if (i < 100) continue
      let m = 0; const rets: number[] = []
      for (let j = i - 100; j < i; j++) rets.push((closes[j + 1] - closes[j]) / closes[j])
      m = rets.reduce((a: number, b: number) => a + b, 0) / 100
      const sd = Math.sqrt(rets.reduce((a: number, b: number) => a + (b - m) ** 2, 0) / 100)
      const r = (closes[i] - closes[i - 1]) / closes[i - 1]
      if (sd > 0 && Math.abs(r) > 3.5 * sd) recentSigma++
    }

    const verdict = !dnaPass ? "❌ DNA Fail" : (sweeps === 0 && recentSigma === 0) ? "💤 Dead Market" : "🎯 Setup!"
    
    console.log(`${t.symbol.padEnd(12)}| ${(t.amount24/1e6).toFixed(0).padStart(7)} | ${dnaPass ? "✅ Yes" : "❌ No"}     | ${sweeps.toString().padStart(12)} | ${recentSigma.toString().padStart(12)} | ${verdict}`)
  }
}
main().catch(console.error)

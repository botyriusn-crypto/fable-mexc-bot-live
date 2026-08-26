// Test if the DNA filter is rejecting all candidates
async function main() {
  const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const tickerJson = await tickerRes.json() as any
  if (!tickerJson.success) throw new Error("Ticker fetch failed")
  
  const minVolume = 1_000_000
  const volCandidates = (tickerJson.data as any[])
    .filter((t: any) => t.symbol.endsWith("_USDT") && t.lastPrice > 0)
    .filter((t: any) => t.amount24 >= minVolume)
    .sort((a: any, b: any) => b.amount24 - a.amount24)
    .slice(0, 50)
  
  console.log(`Testing ${volCandidates.length} volume candidates...`)
  
  const dnaFiltered: any[] = []
  for (const t of volCandidates) {
    if (dnaFiltered.length >= 30) break
    try {
      const end = Math.floor(Date.now() / 1000)
      const start = end - 7 * 86400
      const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min5&start=${start}&end=${end}`)
      const klineJson = await klineRes.json() as any
      if (!klineJson.success || !klineJson.data?.time || klineJson.data.time.length < 200) {
        console.log(`  ${t.symbol}: insufficient kline data`)
        continue
      }
      
      const { time, close: closes, high, low } = klineJson.data
      const n = closes.length
      const lastClose = closes[n - 1]
      
      // ATR%
      let trSum = 0
      for (let i = n - 14; i < n; i++) {
        const tr = Math.max(high[i] - low[i], Math.abs(high[i] - closes[i-1]), Math.abs(low[i] - closes[i-1]))
        trSum += tr
      }
      const atrPct = (trSum / 14 / lastClose) * 100
      
      // Sigma reversion rate
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
      
      const passesDNA = atrPct >= 0.3 && atrPct <= 0.6 && sigmaRevertRate >= 18 && sigmaRevertRate <= 30
      
      if (passesDNA) {
        dnaFiltered.push(t)
        console.log(`  ✓ ${t.symbol.padEnd(12)} ATR=${atrPct.toFixed(2)}% σRev=${sigmaRevertRate.toFixed(1)}%`)
      } else {
        console.log(`  ✗ ${t.symbol.padEnd(12)} ATR=${atrPct.toFixed(2)}% σRev=${sigmaRevertRate.toFixed(1)}% (failed)`)
      }
    } catch (e) {
      console.log(`  ✗ ${t.symbol}: fetch error`)
    }
  }
  
  console.log(`\n${dnaFiltered.length} passed DNA filter out of ${volCandidates.length} candidates`)
}

main().catch(console.error)

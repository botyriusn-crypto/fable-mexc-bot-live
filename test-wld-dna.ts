async function testWLD() {
  const end = Math.floor(Date.now() / 1000)
  const start = end - 7 * 86400
  const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/WLD_USDT?interval=Min5&start=${start}&end=${end}`)
  const klineJson = await klineRes.json() as any
  if (!klineJson.success || !klineJson.data?.time) { console.log("Fetch failed"); return }
  
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
  
  console.log(`WLD: ATR=${atrPct.toFixed(2)}% σRev=${sigmaRevertRate.toFixed(1)}%`)
  console.log(`  Gate check: ATR 0.3-0.7%? ${atrPct >= 0.3 && atrPct <= 0.7}`)
  console.log(`  Gate check: σRev 15-32%? ${sigmaRevertRate >= 15 && sigmaRevertRate <= 32}`)
  console.log(`  Would pass? ${atrPct >= 0.3 && atrPct <= 0.7 && sigmaRevertRate >= 15 && sigmaRevertRate <= 32}`)
}

testWLD().catch(console.error)

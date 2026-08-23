import { detectSniper } from "../lib/sniper"
// ... (same fetch/build functions)

async function main() {
  console.log("=== SHORT-SIDE ONLY PERFORMANCE (with fixes) ===\n")
  
  const res = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const json = await res.json() as any
  const symbols = json.data
    .filter((t:any)=>t.symbol.endsWith("_USDT") && !t.symbol.includes("3L") && !t.symbol.includes("3S"))
    .filter((t:any)=>t.amount24>=10_000_000 && t.amount24<=200_000_000)
    .sort((a:any,b:any)=>b.amount24-a.amount24).slice(0,20).map((t:any)=>t.symbol)

  let totalShorts = 0, shortWins = 0, shortR = 0
  
  for (const sym of symbols) {
    const candles = await fetchKlines(sym, 30)
    if (candles.length < 500) continue
    
    for (let i = 200; i < candles.length - 288; i++) {
      const window = candles.slice(Math.max(0, i - 200), i + 1)
      const sig = detectSniper(window, buildSnap(window), 0, { sigmaExtreme: 3.5, volumeSurgeMult: 2.0 })
      if (sig.direction !== "short") continue
      
      totalShorts++
      const entry = candles[i].close, sl = sig.stopLoss, tp = sig.takeProfit
      const stopDist = Math.abs(entry - sl)
      
      for (let j = i + 1; j < Math.min(i + 288, candles.length); j++) {
        if (candles[j].high >= sl) { shortR -= 1; break }
        if (candles[j].low <= tp) { shortR += (entry - tp) / stopDist; shortWins++; break }
      }
    }
  }
  
  console.log(`Total shorts: ${totalShorts}`)
  console.log(`Wins: ${shortWins}`)
  console.log(`Win rate: ${(shortWins/totalShorts*100).toFixed(1)}%`)
  console.log(`Total R: ${shortR.toFixed(1)}`)
  console.log(`Avg R: ${(shortR/totalShorts).toFixed(3)}`)
}

main().catch(console.error)

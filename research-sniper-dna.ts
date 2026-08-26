// Sniper DNA: winners (trend sweet spot) vs losers
import { atr, adx, ema } from "./lib/indicators"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchCandles(symbol: string, interval: string, days: number): Promise<Candle[]> {
  const isec = interval === "Min15" ? 900 : interval === "Min5" ? 300 : 3600
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const res = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&start=${start}&end=${end}`)
  const json = await res.json() as any
  if (!json.success || !json.data?.time) return []
  const { time, open, high, low, close, vol } = json.data
  return time.map((t: number, i: number) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 }))
}

async function analyze(symbol: string, group: "WINNER" | "LOSER", pnl: number) {
  const m15 = await fetchCandles(symbol, "Min15", 7)
  const h1 = await fetchCandles(symbol, "Hour1", 30)
  if (m15.length < 100 || h1.length < 100) { console.log(`${symbol}: insufficient data`); return null }
  
  const closes15 = m15.map(c => c.close)
  const last15 = closes15[closes15.length - 1]
  const atr15 = atr(m15, 14)
  const adx15 = adx(m15, 14)
  const atrPct = (atr15[atr15.length-1] / last15) * 100
  const adxM15 = adx15[adx15.length-1]
  
  const closesH1 = h1.map(c => c.close)
  const adxH1arr = adx(h1, 14)
  const adxH1 = adxH1arr[adxH1arr.length-1]
  
  // H1 directional drift (trend strength over 30d)
  const driftH1 = ((closesH1[closesH1.length-1] - closesH1[0]) / closesH1[0]) * 100
  
  // H1 EMA alignment (trend coherence)
  const emaF = ema(closesH1, 20)
  const emaS = ema(closesH1, 50)
  const aligned = emaF[emaF.length-1] > emaS[emaS.length-1] ? 1 : -1
  
  // Volatility expansion: recent ATR vs 30d avg ATR
  const atrH1 = atr(h1, 14)
  const avgAtrH1 = atrH1.slice(-100).reduce((a,b)=>a+b,0) / 100
  const lastAtrH1 = atrH1[atrH1.length-1]
  const volExpansion = lastAtrH1 / Math.max(avgAtrH1, 1e-9)
  
  console.log(`${group.padEnd(6)} ${symbol.padEnd(11)} PnL $${pnl.toString().padStart(6)} | ATR% ${atrPct.toFixed(2).padStart(5)} | ADX-M15 ${adxM15.toFixed(0).padStart(4)} | ADX-H1 ${adxH1.toFixed(0).padStart(4)} | driftH1 ${driftH1.toFixed(1).padStart(6)}% | volExp ${volExpansion.toFixed(2).padStart(5)}`)
  
  return { symbol, group, pnl, atrPct, adxM15, adxH1, driftH1, volExpansion }
}

async function main() {
  console.log("=== Sniper DNA: Winners vs Losers ===\n")
  console.log("Group  Symbol      PnL      | ATR%  | ADX15 | ADXH1 | drift  | volExp")
  console.log("-------|-----------|--------|-------|-------|-------|--------|-------")
  
  // From validated backtest (v2 suite, current config)
  const winners = [
    ["LINK_USDT", 1213], ["SUI_USDT", 690], ["DOGE_USDT", 445],
    ["AVAX_USDT", 407], ["HYPE_USDT", 328]
  ]
  const losers = [
    ["PEPE_USDT", -1917], ["ZEN_USDT", -846], ["TAO_USDT", -661],
    ["SEI_USDT", -664], ["BASED_USDT", -386]
  ]
  
  const results: any[] = []
  for (const [sym, pnl] of winners) {
    const r = await analyze(sym as string, "WINNER", pnl as number)
    if (r) results.push(r)
  }
  for (const [sym, pnl] of losers) {
    const r = await analyze(sym as string, "LOSER", pnl as number)
    if (r) results.push(r)
  }
  
  const W = results.filter(r => r.group === "WINNER")
  const L = results.filter(r => r.group === "LOSER")
  
  const avg = (arr: number[]) => arr.reduce((a,b)=>a+b,0) / Math.max(arr.length,1)
  
  console.log("\n=== Averages ===")
  console.log(`WINNERS (${W.length}): ATR ${avg(W.map(r=>r.atrPct)).toFixed(2)}% | ADX15 ${avg(W.map(r=>r.adxM15)).toFixed(0)} | ADXH1 ${avg(W.map(r=>r.adxH1)).toFixed(0)} | drift ${avg(W.map(r=>r.driftH1)).toFixed(1)}% | volExp ${avg(W.map(r=>r.volExpansion)).toFixed(2)}`)
  console.log(`LOSERS  (${L.length}): ATR ${avg(L.map(r=>r.atrPct)).toFixed(2)}% | ADX15 ${avg(L.map(r=>r.adxM15)).toFixed(0)} | ADXH1 ${avg(L.map(r=>r.adxH1)).toFixed(0)} | drift ${avg(L.map(r=>r.driftH1)).toFixed(1)}% | volExp ${avg(L.map(r=>r.volExpansion)).toFixed(2)}`)
  
  console.log("\n=== Sniper Trend Sweet Spot (hypothesis) ===")
  console.log("Sniper needs: enough ATR for sweeps + trending regime (ADX above grid's <25)")
  console.log("Compare winner vs loser ADX/ATR to find the separating threshold")
}

main().catch(console.error)

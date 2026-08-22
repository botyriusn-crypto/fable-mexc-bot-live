// Phase C: Stress test - what happens when price trends?
const FEE = 0
const SPREAD: Record<string, number> = {
  BTC_USDT: .0001, SOL_USDT: .0002, AVAX_USDT: .0002, ETH_USDT: .0001, LINK_USDT: .0002,
}
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchAll(sym: string, days = 60): Promise<Candle[]> {
  const isec = 900, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, open, high, low, close, vol } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

interface GridResult { 
  realizedPnL: number
  inventoryValue: number
  inventoryCount: number
  trades: number
  maxInv: number
}

function grid(sym: string, c: Candle[], spacing: number, depth: number, startIdx: number, endIdx: number): GridResult {
  const sp = SPREAD[sym] ?? 0.001
  let realizedPnL = 0, currentInv = 0, maxInv = 0
  let buys: { p: number; q: number }[] = [], sells: { p: number; q: number; bp: number }[] = []
  let trades = 0
  
  for (let i = startIdx; i < endIdx; i++) {
    const price = c[i].close
    if (!buys.length && !sells.length) {
      for (let l = 1; l <= depth; l++) {
        const bp = price * (1 - spacing / 100 * l)
        buys.push({ p: bp, q: 500 / bp })
      }
    }
    for (const b of [...buys]) {
      if (price <= b.p) {
        buys = buys.filter(x => x !== b)
        sells.push({ p: b.p * (1 + spacing / 100), q: b.q, bp: b.p })
        currentInv += b.p * b.q
      }
    }
    for (const s of [...sells]) {
      if (price >= s.p) {
        sells = sells.filter(x => x !== s)
        const gross = (s.p - s.bp) * s.q
        const cost = (s.p * s.q + s.bp * s.q) * sp
        realizedPnL += gross - cost
        currentInv -= s.bp * s.q
        buys.push({ p: s.bp, q: s.q })
        trades++
      }
    }
    maxInv = Math.max(maxInv, currentInv)
  }
  
  // Calculate remaining inventory value
  let inventoryValue = 0
  for (const s of sells) {
    inventoryValue += s.bp * s.q
  }
  
  return { 
    realizedPnL, 
    inventoryValue,
    inventoryCount: sells.length,
    trades, 
    maxInv 
  }
}

async function main() {
  const symbols = ["BTC_USDT", "SOL_USDT", "AVAX_USDT", "ETH_USDT", "LINK_USDT"]
  const spacing = 0.30, depth = 3
  
  console.log("Stress Test: Grid with 0.30% spacing, depth 3\n")
  
  // Test 30-day period
  console.log("30-Day Performance:")
  console.log(" symbol       | trades | realized PnL | inventory held | inventory value")
  const results30d: Record<string, GridResult> = {}
  for (const sym of symbols) {
    const c = await fetchAll(sym, 30)
    if (c.length < 300) continue
    const r = grid(sym, c, spacing, depth, 200, c.length)
    results30d[sym] = r
    console.log(` ${sym.padEnd(12)} | ${String(r.trades).padStart(6)} | $${r.realizedPnL.toFixed(0).padStart(8)} | ${String(r.inventoryCount).padStart(14)} | $${r.inventoryValue.toFixed(0).padStart(5)}`)
  }
  
  // Simulate 10% drop on remaining inventory
  console.log("\n\nWorst Case: What if price drops 10% and stays there?")
  console.log(" symbol       | realized | inventory loss (10%) | total PnL | breakeven?")
  for (const sym of symbols) {
    const r = results30d[sym]
    const unrealizedLoss = r.inventoryValue * 0.10
    const total = r.realizedPnL - unrealizedLoss
    const breakeven = total >= 0
    console.log(` ${sym.padEnd(12)} | $${r.realizedPnL.toFixed(0).padStart(8)} | -$${unrealizedLoss.toFixed(0).padStart(19)} | $${total.toFixed(0).padStart(7)} | ${breakeven ? "✅ YES" : "❌ NO"}`)
  }
  
  // Calculate break-even drop percentage
  console.log("\n\nBreak-even Analysis: How much can price drop before losses?")
  console.log(" symbol       | realized | inventory | max safe drop")
  for (const sym of symbols) {
    const r = results30d[sym]
    const maxDrop = r.inventoryValue > 0 ? (r.realizedPnL / r.inventoryValue) * 100 : 999
    console.log(` ${sym.padEnd(12)} | $${r.realizedPnL.toFixed(0).padStart(8)} | $${r.inventoryValue.toFixed(0).padStart(5)} | ${maxDrop.toFixed(1)}%`)
  }
  
  // 60-day performance
  console.log("\n\n60-Day Performance:")
  console.log(" symbol       | trades | realized PnL | inventory held")
  for (const sym of symbols) {
    const c = await fetchAll(sym, 60)
    if (c.length < 400) continue
    const r = grid(sym, c, spacing, depth, 200, c.length)
    console.log(` ${sym.padEnd(12)} | ${String(r.trades).padStart(6)} | $${r.realizedPnL.toFixed(0).padStart(8)} | ${String(r.inventoryCount).padStart(14)}`)
  }
}

main()

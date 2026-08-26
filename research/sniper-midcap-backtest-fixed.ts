import { detectSniper } from "../lib/sniper"

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Trade { symbol: string; dir: string; entry: number; exit: number; r: number; win: boolean; bars: number }

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

  return {
    price: closes[n - 1],
    atr: atrVal,
    adx: 25,
    emaFast: closes[n - 1],
    emaSlow: closes[n - 1],
    rsi: rsiVal,
    bb: { upper: 0, middle: 0, lower: 0 },
  } as any
}

async function getMidCapUniverse(): Promise<string[]> {
  console.log("Fetching MEXC universe...")
  const res = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
  const json = await res.json() as any
  const tickers = json.data as any[]

  const megaCaps = new Set(["BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT", "XRP_USDT", "DOGE_USDT", "ADA_USDT", "AVAX_USDT", "LINK_USDT"])
  
  const midCaps = tickers
    .filter(t => t.symbol.endsWith("_USDT"))
    .filter(t => !megaCaps.has(t.symbol))
    .filter(t => !t.symbol.includes("3L") && !t.symbol.includes("3S") && !t.symbol.includes("STOCK"))
    .filter(t => t.amount24 >= 10_000_000 && t.amount24 <= 200_000_000)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, 20)

  console.log(`Selected ${midCaps.length} mid-cap coins\n`)
  return midCaps.map(t => t.symbol)
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
    await new Promise(r => setTimeout(r, 100))
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
    
    // Calculate R based on actual stop distance
    const stopDist = Math.abs(entry - sl)

    for (let j = i + 1; j < Math.min(i + 288, candles.length); j++) {
      if (sig.direction === "long") {
        if (candles[j].low <= sl) { 
          trades.push({ symbol: sym, dir: "L", entry, exit: sl, r: -1, win: false, bars: j - i })
          break 
        }
        if (candles[j].high >= tp) { 
          const rMultiple = (tp - entry) / stopDist
          trades.push({ symbol: sym, dir: "L", entry, exit: tp, r: rMultiple, win: true, bars: j - i })
          break 
        }
      } else {
        if (candles[j].high >= sl) { 
          trades.push({ symbol: sym, dir: "S", entry, exit: sl, r: -1, win: false, bars: j - i })
          break 
        }
        if (candles[j].low <= tp) { 
          const rMultiple = (entry - tp) / stopDist
          trades.push({ symbol: sym, dir: "S", entry, exit: tp, r: rMultiple, win: true, bars: j - i })
          break 
        }
      }
    }
  }
  return trades
}

async function main() {
  console.log("=== Sniper Mid-Cap Backtest (FIXED: using actual signal stops) ===\n")
  const symbols = await getMidCapUniverse()
  
  const allTrades: Trade[] = []
  const coinStats: any[] = []

  for (const sym of symbols) {
    process.stdout.write(`Backtesting ${sym}... `)
    const candles = await fetchKlines(sym, 30)
    if (candles.length < 500) { console.log("insufficient data"); continue }

    const trades = runBacktest(candles, sym)
    allTrades.push(...trades)
    
    const wins = trades.filter(t => t.win).length
    const wr = trades.length > 0 ? (wins / trades.length * 100) : 0
    const totalR = trades.reduce((s, t) => s + t.r, 0)
    const avgR = trades.length > 0 ? totalR / trades.length : 0

    coinStats.push({ sym, trades: trades.length, wins, wr, totalR, avgR })
    console.log(`${trades.length} trades, ${wr.toFixed(1)}% WR, ${totalR.toFixed(1)} R`)
  }

  console.log("\n" + "=".repeat(80))
  console.log("=== AGGREGATE PERFORMANCE (30 DAYS) ===")
  console.log("=".repeat(80))
  
  const totalTrades = allTrades.length
  const totalWins = allTrades.filter(t => t.win).length
  const totalR = allTrades.reduce((s, t) => s + t.r, 0)
  const avgR = totalTrades > 0 ? totalR / totalTrades : 0
  const wr = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0

  console.log(`Total Signals:    ${totalTrades}`)
  console.log(`Win Rate:         ${wr.toFixed(1)}%`)
  console.log(`Avg R per trade:  ${avgR.toFixed(3)}`)
  console.log(`Total R (30d):    ${totalR.toFixed(1)}`)
  console.log(`Avg bars to exit: ${totalTrades > 0 ? (allTrades.reduce((s,t) => s+t.bars, 0) / totalTrades).toFixed(1) : 0}`)

  coinStats.sort((a, b) => b.totalR - a.totalR)
  console.log("\n" + "=".repeat(80))
  console.log("=== TOP 5 & BOTTOM 5 MID-CAPS ===")
  console.log("=".repeat(80))
  console.log(`${"Symbol".padEnd(14)} | ${"Trades".padEnd(6)} | ${"Wins".padEnd(5)} | ${"WR".padEnd(6)} | ${"Avg R".padEnd(8)} | ${"Total R".padEnd(8)}`)
  console.log("-".repeat(65))
  
  for (const c of coinStats.slice(0, 5)) {
    console.log(`${c.sym.padEnd(14)} | ${c.trades.toString().padStart(6)} | ${c.wins.toString().padStart(5)} | ${(c.wr.toFixed(1) + "%").padStart(6)} | ${c.avgR.toFixed(3).padStart(8)} | ${c.totalR.toFixed(1).padStart(8)}`)
  }
  console.log("..." + "-".repeat(62))
  for (const c of coinStats.slice(-5)) {
    console.log(`${c.sym.padEnd(14)} | ${c.trades.toString().padStart(6)} | ${c.wins.toString().padStart(5)} | ${(c.wr.toFixed(1) + "%").padStart(6)} | ${c.avgR.toFixed(3).padStart(8)} | ${c.totalR.toFixed(1).padStart(8)}`)
  }

  const grossWin = allTrades.filter(t => t.win).reduce((s, t) => s + t.r, 0)
  const grossLoss = Math.abs(allTrades.filter(t => !t.win).reduce((s, t) => s + t.r, 0))
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "Inf"
  console.log(`\nProfit Factor:    ${profitFactor}`)
}

main().catch(console.error)

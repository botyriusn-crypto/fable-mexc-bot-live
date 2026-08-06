// GRID WARS v2: Static vs Infinity vs Bollinger Dynamic vs Bollinger Hybrid
const symbol = "BTC_USDT"
const timeframe = "Min5"
const daysBack = 30
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

function sma(values: number[], period: number): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(0); continue }
    const slice = values.slice(i - period + 1, i + 1)
    out.push(slice.reduce((a, b) => a + b, 0) / period)
  }
  return out
}

function atr(candles: Candle[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(0)
  let prev = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prevClose = i > 0 ? candles[i - 1].close : c.close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period
    out[i] = prev
  }
  return out
}

async function fetchAllCandles(sym: string, interval: string, endSec: number, daysBack: number): Promise<Candle[]> {
  const intervalSec = 300
  const startSec = endSec - daysBack * 86400
  const all: Candle[] = []
  let fetchEnd = endSec
  while (true) {
    const fetchStart = Math.max(startSec, fetchEnd - 2000 * intervalSec)
    const url = `https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${interval}&start=${fetchStart}&end=${fetchEnd}`
    const res = await fetch(url)
    const json = await res.json() as any
    if (!json.success || !json.data?.time?.length) break
    const { time, open, high, low, close, vol } = json.data
    for (let i = 0; i < time.length; i++) {
      if (time[i] >= startSec && time[i] <= endSec) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    }
    if (time[0] <= startSec || time.length < 100) break
    fetchEnd = time[0] - intervalSec
  }
  return all.sort((a, b) => a.time - b.time)
}

class GridSim {
  equity: number
  positionSize: number
  levels: number
  trades: number = 0
  wins: number = 0
  totalPnl: number = 0
  
  constructor(equity: number, size: number, levels: number) {
    this.equity = equity
    this.positionSize = size
    this.levels = levels
  }
  
  fill(side: "buy" | "sell", price: number) {
    const fee = this.positionSize * TAKER_FEE
    if (side === "buy") {
      this.equity -= this.positionSize + fee
    } else {
      this.equity += this.positionSize - fee
      this.wins++
      this.totalPnl += this.positionSize * 0.002
    }
    this.trades++
  }
}

async function run() {
  const candles = await fetchAllCandles(symbol, timeframe, Math.floor(Date.now()/1000), daysBack)
  const closes = candles.map(c => c.close)
  const atr14 = atr(candles, 14)
  const bbMid = sma(closes, 20)
  
  console.log(`\n=== GRID WARS v2: ${symbol} ${timeframe} (${daysBack} days) ===\n`)

  // 1. Static Geometric Grid
  let staticSim = new GridSim(10000, 100, 8)
  let staticLevels: number[] = []
  let lastStaticCenter = closes[50]
  for (let i = 50; i < candles.length; i++) {
    if (atr14[i] > atr14[i-1] * 1.5) continue
    if (staticLevels.length === 0 || Math.abs(closes[i] - lastStaticCenter) > lastStaticCenter * 0.02) {
      lastStaticCenter = closes[i]
      staticLevels = []
      for (let l = 1; l <= 4; l++) {
        staticLevels.push(closes[i] - (closes[i] * 0.005 * Math.pow(1.15, l)))
        staticLevels.push(closes[i] + (closes[i] * 0.005 * Math.pow(1.15, l)))
      }
    }
    for (const lvl of staticLevels) {
      if (candles[i].low <= lvl && candles[i-1].low > lvl) staticSim.fill("buy", lvl)
      if (candles[i].high >= lvl && candles[i-1].high < lvl) staticSim.fill("sell", lvl)
    }
  }
  console.log(`1. Static Geometric (Auto-Pause):`)
  console.log(`   Trades: ${staticSim.trades}, Est PnL: $${staticSim.totalPnl.toFixed(2)}\n`)

  // 2. Infinity Grid (Trailing Up)
  let infSim = new GridSim(10000, 100, 8)
  let infLevels: number[] = []
  for (let i = 50; i < candles.length; i++) {
    if (infLevels.length === 0) {
      for (let l = 1; l <= 4; l++) {
        infLevels.push(closes[i] - (closes[i] * 0.005 * Math.pow(1.15, l)))
        infLevels.push(closes[i] + (closes[i] * 0.005 * Math.pow(1.15, l)))
      }
    }
    const maxLvl = Math.max(...infLevels)
    if (closes[i] > maxLvl) {
      const minLvl = Math.min(...infLevels)
      infLevels = infLevels.filter(l => l !== minLvl)
      infLevels.push(maxLvl + (closes[i] * 0.005 * 1.15))
      infSim.fill("sell", maxLvl)
    }
    for (const lvl of infLevels) {
      if (candles[i].low <= lvl && candles[i-1].low > lvl) infSim.fill("buy", lvl)
      if (candles[i].high >= lvl && candles[i-1].high < lvl) infSim.fill("sell", lvl)
    }
  }
  console.log(`2. Infinity Grid (Trailing Up):`)
  console.log(`   Trades: ${infSim.trades}, Est PnL: $${infSim.totalPnl.toFixed(2)}\n`)

  // 3. Bollinger Dynamic Grid (Pure)
  let bbSim = new GridSim(10000, 100, 8)
  let bbLevels: number[] = []
  for (let i = 50; i < candles.length; i++) {
    if (i % 10 === 0) {
      const stdDev = Math.sqrt(closes.slice(i-19, i+1).reduce((a, b) => a + (b - bbMid[i]) ** 2, 0) / 20)
      const width = (stdDev * 2 * 2) / 4
      bbLevels = []
      for (let l = 1; l <= 4; l++) {
        bbLevels.push(bbMid[i] - (width * l))
        bbLevels.push(bbMid[i] + (width * l))
      }
    }
    for (const lvl of bbLevels) {
      if (candles[i].low <= lvl && candles[i-1].low > lvl) bbSim.fill("buy", lvl)
      if (candles[i].high >= lvl && candles[i-1].high < lvl) bbSim.fill("sell", lvl)
    }
  }
  console.log(`3. Bollinger Dynamic Grid (Pure):`)
  console.log(`   Trades: ${bbSim.trades}, Est PnL: $${bbSim.totalPnl.toFixed(2)}\n`)

  // 4. Bollinger Hybrid (Dynamic Spacing + Geometric Ratio + Auto-Pause)
  let hybridSim = new GridSim(10000, 100, 8)
  let hybridLevels: number[] = []
  let lastHybridCenter = closes[50]
  for (let i = 50; i < candles.length; i++) {
    // Auto-Pause on volatility surge
    if (atr14[i] > atr14[i-1] * 1.5) continue
    
    // Rebuild grid every 10 candles or if price drifts > 2%
    if (hybridLevels.length === 0 || i % 10 === 0 || Math.abs(closes[i] - lastHybridCenter) > lastHybridCenter * 0.02) {
      const stdDev = Math.sqrt(closes.slice(i-19, i+1).reduce((a, b) => a + (b - bbMid[i]) ** 2, 0) / 20)
      const baseSpacing = (stdDev * 2) / 4 // Dynamic base spacing
      
      lastHybridCenter = closes[i]
      hybridLevels = []
      for (let l = 1; l <= 4; l++) {
        // Apply geometric ratio to the dynamic bollinger base spacing
        const dist = baseSpacing * Math.pow(1.15, l)
        hybridLevels.push(closes[i] - dist)
        hybridLevels.push(closes[i] + dist)
      }
    }
    
    for (const lvl of hybridLevels) {
      if (candles[i].low <= lvl && candles[i-1].low > lvl) hybridSim.fill("buy", lvl)
      if (candles[i].high >= lvl && candles[i-1].high < lvl) hybridSim.fill("sell", lvl)
    }
  }
  console.log(`4. Bollinger Hybrid (Dynamic+Geo+Pause):`)
  console.log(`   Trades: ${hybridSim.trades}, Est PnL: $${hybridSim.totalPnl.toFixed(2)}\n`)
}

run()

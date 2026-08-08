// Walk-Forward Grid Backtest: 90 days split into 3x 30-day periods
const symbol = "BTC_USDT"
const timeframe = "Min5"
const TAKER_FEE = 0.0002 // 0.02% MEXC Futures Taker Fee

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

async function fetchAllCandles(sym: string, interval: string, daysBack: number): Promise<Candle[]> {
  const intervalSec = 300
  const endSec = Math.floor(Date.now() / 1000)
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

// Realistic Grid Simulator with Inventory Tracking
class GridSim {
  equity: number
  cash: number
  inventory: number // BTC held
  levels: number
  trades: number = 0
  wins: number = 0
  totalPnl: number = 0
  maxEquity: number = 10000
  maxDD: number = 0

  constructor(equity: number, levels: number) {
    this.equity = equity
    this.cash = equity
    this.inventory = 0
    this.levels = levels
  }
  
  // Order size fixed at $100 per level for consistent comparison
  fill(side: "buy" | "sell", price: number) {
    const orderSize = 100
    const fee = orderSize * TAKER_FEE
    
    if (side === "buy") {
      this.cash -= (orderSize + fee)
      this.inventory += orderSize / price
    } else {
      if (this.inventory <= 0) return // Can't sell if we don't hold bags
      const sellQty = orderSize / price
      const qtyToSell = Math.min(sellQty, this.inventory)
      this.cash += (qtyToSell * price) - fee
      this.inventory -= qtyToSell
      this.wins++
      this.totalPnl += orderSize * 0.002 // Assume 0.2% grid profit per cycle
    }
    this.trades++
    
    // Update Equity & Drawdown
    this.equity = this.cash + (this.inventory * price)
    if (this.equity > this.maxEquity) this.maxEquity = this.equity
    const dd = ((this.maxEquity - this.equity) / this.maxEquity) * 100
    if (dd > this.maxDD) this.maxDD = dd
  }
}

async function run() {
  console.log(`Fetching 90 days of ${symbol} ${timeframe} data...`)
  const candles = await fetchAllCandles(symbol, timeframe, 90)
  console.log(`Total candles: ${candles.length}\n`)

  const periods = [
    { name: "Days 61-90 (Oldest)", start: 0, end: candles.length / 3 },
    { name: "Days 31-60 (Middle)", start: candles.length / 3, end: (candles.length / 3) * 2 },
    { name: "Days 1-30 (Recent)", start: (candles.length / 3) * 2, end: candles.length }
  ]

  for (const p of periods) {
    const slice = candles.slice(p.start, p.end)
    const closes = slice.map(c => c.close)
    const atr14 = atr(slice, 14)
    const bbMid = sma(closes, 20)
    
    console.log(`=== ${p.name} ===`)

    // 1. Static Geometric Grid
    let staticSim = new GridSim(10000, 8)
    let staticLevels: number[] = []
    for (let i = 50; i < slice.length; i++) {
      if (staticLevels.length === 0 || Math.abs(closes[i] - staticLevels[0]) > closes[i] * 0.02) {
        staticLevels = []
        for (let l = 1; l <= 4; l++) {
          staticLevels.push(closes[i] - (closes[i] * 0.005 * Math.pow(1.15, l)))
          staticLevels.push(closes[i] + (closes[i] * 0.005 * Math.pow(1.15, l)))
        }
      }
      for (const lvl of staticLevels) {
        if (slice[i].low <= lvl && slice[i-1].low > lvl) staticSim.fill("buy", lvl)
        if (slice[i].high >= lvl && slice[i-1].high < lvl) staticSim.fill("sell", lvl)
      }
    }
    console.log(`  Static Geometric: Trades: ${staticSim.trades}, PnL: $${staticSim.totalPnl.toFixed(2)}, Max DD: ${staticSim.maxDD.toFixed(1)}%`)

    // 2. Bollinger Hybrid Grid
    let bbSim = new GridSim(10000, 8)
    let bbLevels: number[] = []
    for (let i = 50; i < slice.length; i++) {
      if (bbLevels.length === 0 || i % 10 === 0) {
        const stdDev = Math.sqrt(closes.slice(i-19, i+1).reduce((a, b) => a + (b - bbMid[i]) ** 2, 0) / 20)
        const baseSpacing = (stdDev * 2) / 4
        bbLevels = []
        for (let l = 1; l <= 4; l++) {
          const dist = baseSpacing * Math.pow(1.15, l)
          bbLevels.push(closes[i] - dist)
          bbLevels.push(closes[i] + dist)
        }
      }
      for (const lvl of bbLevels) {
        if (slice[i].low <= lvl && slice[i-1].low > lvl) bbSim.fill("buy", lvl)
        if (slice[i].high >= lvl && slice[i-1].high < lvl) bbSim.fill("sell", lvl)
      }
    }
    console.log(`  Bollinger Hybrid: Trades: ${bbSim.trades}, PnL: $${bbSim.totalPnl.toFixed(2)}, Max DD: ${bbSim.maxDD.toFixed(1)}%\n`)
  }
}

run()

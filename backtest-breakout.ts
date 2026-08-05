// 15m Breakout Sniper: BB Squeeze + Volume + Trailing Stop (No fixed TP)
const symbol = "BTC_USDT"
const timeframe = "Min15"
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
  const intervalSec = 900 // 15m
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

async function run() {
  const candles = await fetchAllCandles(symbol, timeframe, Math.floor(Date.now()/1000), daysBack)
  console.log(`Testing ${symbol} ${timeframe} Breakout Strategy (Trailing Stop)...`)
  
  const closes = candles.map(c => c.close)
  const vols = candles.map(c => c.volume)
  const bbMid = sma(closes, 20)
  const atr14 = atr(candles, 14)
  const volSma = sma(vols, 20)
  
  // Calculate BB Width
  const bbWidth: number[] = []
  const bbUpper: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < 19) { bbWidth.push(0); bbUpper.push(0); continue }
    const slice = closes.slice(i - 19, i + 1)
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - bbMid[i]) ** 2, 0) / 20)
    const u = bbMid[i] + std * 2
    const l = bbMid[i] - std * 2
    bbUpper.push(u)
    bbWidth.push((u - l) / bbMid[i])
  }
  
  let equity = 10000
  let position: { side: "long" | "short"; entry: number; sl: number; highest: number; lowest: number; qty: number } | null = null
  const trades: any[] = []
  
  for (let i = 21; i < candles.length; i++) {
    const c = candles[i]
    
    // Exit logic (Trailing Stop)
    if (position) {
      let closed = false
      if (position.side === "long") {
        if (c.high > position.highest) position.highest = c.high
        const trail = position.highest - (atr14[i] * 2.0) // 2x ATR trailing stop
        if (c.low <= trail) {
          const pnl = (trail - position.entry) * position.qty - (position.entry * position.qty * TAKER_FEE * 2)
          equity += pnl
          trades.push({ pnl, win: pnl > 0 })
          closed = true
        }
      } else if (position.side === "short") {
        if (c.low < position.lowest) position.lowest = c.low
        const trail = position.lowest + (atr14[i] * 2.0)
        if (c.high >= trail) {
          const pnl = (position.entry - trail) * position.qty - (position.entry * position.qty * TAKER_FEE * 2)
          equity += pnl
          trades.push({ pnl, win: pnl > 0 })
          closed = true
        }
      }
      if (closed) position = null
    }
    
    // Entry Logic: BB Squeeze Breakout
    if (!position) {
      // Look back 20 periods to see if current BB width is the tightest (squeeze)
      const lookback = bbWidth.slice(Math.max(0, i - 20), i)
      const minWidth = Math.min(...lookback)
      const isSqueeze = bbWidth[i-1] <= minWidth * 1.1 // Within 10% of tightest
      
      const volSpike = c.volume > volSma[i] * 1.5 // 50% volume surge
      
      if (isSqueeze && volSpike) {
        if (c.close > bbUpper[i-1]) { // Bullish breakout
          const entry = c.close
          const sl = c.low - (atr14[i] * 0.5) // Stop below breakout candle
          const qty = (equity * 0.01) / Math.abs(entry - sl) // Risk 1%
          position = { side: "long", entry, sl, highest: c.high, lowest: c.low, qty }
        }
      }
    }
  }
  
  // Close open trade at end of backtest
  if (position) {
    const lastPrice = candles[candles.length - 1].close
    const pnl = (lastPrice - position.entry) * position.qty - (position.entry * position.qty * TAKER_FEE * 2)
    equity += pnl
    trades.push({ pnl, win: pnl > 0 })
  }
  
  const wins = trades.filter(t => t.win).length
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const avgWin = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0) / (wins || 1)
  const avgLoss = trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0) / (trades.length - wins || 1)
  
  console.log(`Trades: ${trades.length}`)
  console.log(`Win Rate: ${trades.length > 0 ? ((wins/trades.length)*100).toFixed(1) : 0}%`)
  console.log(`Avg Win: ${avgWin.toFixed(2)} USDT | Avg Loss: ${avgLoss.toFixed(2)} USDT`)
  console.log(`Total PnL: ${totalPnl.toFixed(2)} USDT`)
  console.log(`Final Equity: ${equity.toFixed(2)} USDT`)
}
run()

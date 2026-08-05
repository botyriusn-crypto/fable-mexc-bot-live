// Mean Reversion Sniper: BB extreme + RSI + 1.5:1 RR
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

function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    const gain = Math.max(change, 0), loss = Math.max(-change, 0)
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period; out[i] = 50 }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) }
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

async function run() {
  const candles = await fetchAllCandles(symbol, timeframe, Math.floor(Date.now()/1000), daysBack)
  console.log(`Testing ${symbol} ${timeframe} Mean Reversion Strategy...`)
  
  const closes = candles.map(c => c.close)
  const bbMid = sma(closes, 20)
  const rsi14 = rsi(closes, 14)
  const atr14 = atr(candles, 14)
  
  // Calculate BB Upper/Lower
  const bbUpper: number[] = [], bbLower: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < 19) { bbUpper.push(0); bbLower.push(0); continue }
    const slice = closes.slice(i - 19, i + 1)
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - bbMid[i]) ** 2, 0) / 20)
    bbUpper.push(bbMid[i] + std * 2)
    bbLower.push(bbMid[i] - std * 2)
  }
  
  let equity = 10000
  let position: { side: "long" | "short"; entry: number; sl: number; tp: number; qty: number } | null = null
  const trades: any[] = []
  
  for (let i = 21; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i-1]
    
    // Exit logic
    if (position) {
      if (position.side === "long" && (c.low <= position.sl || c.high >= position.tp)) {
        const exit = c.low <= position.sl ? position.sl : position.tp
        const pnl = (exit - position.entry) * position.qty - (position.entry * position.qty * TAKER_FEE * 2)
        equity += pnl
        trades.push({ pnl, win: pnl > 0 })
        position = null
      } else if (position.side === "short" && (c.high >= position.sl || c.low <= position.tp)) {
        const exit = c.high >= position.sl ? position.sl : position.tp
        const pnl = (position.entry - exit) * position.qty - (position.entry * position.qty * TAKER_FEE * 2)
        equity += pnl
        trades.push({ pnl, win: pnl > 0 })
        position = null
      }
    }
    
    // Entry Logic: Mean Reversion
    if (!position) {
      // Long: Close below lower BB, RSI < 30
      if (prev.close < bbLower[i-1] && rsi14[i-1] < 30) {
        const entry = c.open
        const sl = entry - (atr14[i] * 1.0) // 1x ATR stop
        const tp = bbMid[i] // Target is the middle of the BB
        const riskUsdt = equity * 0.01 // Risk 1%
        const qty = riskUsdt / Math.abs(entry - sl)
        position = { side: "long", entry, sl, tp, qty }
      }
      // Short: Close above upper BB, RSI > 70
      else if (prev.close > bbUpper[i-1] && rsi14[i-1] > 70) {
        const entry = c.open
        const sl = entry + (atr14[i] * 1.0) // 1x ATR stop
        const tp = bbMid[i] // Target is the middle of the BB
        const riskUsdt = equity * 0.01 // Risk 1%
        const qty = riskUsdt / Math.abs(entry - sl)
        position = { side: "short", entry, sl, tp, qty }
      }
    }
  }
  
  const wins = trades.filter(t => t.win).length
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  console.log(`Trades: ${trades.length}`)
  console.log(`Win Rate: ${trades.length > 0 ? ((wins/trades.length)*100).toFixed(1) : 0}%`)
  console.log(`Total PnL: ${totalPnl.toFixed(2)} USDT`)
  console.log(`Final Equity: ${equity.toFixed(2)} USDT`)
}
run()

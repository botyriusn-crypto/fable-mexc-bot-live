// Trend Pullback Sniper: Waits for macro trend, buys the pullback, wide ATR stop.
const symbol = "BTC_USDT"
const timeframe = "Min5"
const daysBack = 30
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(prev)
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
  console.log(`Testing ${symbol} ${timeframe} Trend Pullback Strategy...`)
  
  const closes = candles.map(c => c.close)
  const ema50 = ema(closes, 50)
  const ema200 = ema(closes, 200)
  const rsi14 = rsi(closes, 14)
  const atr14 = atr(candles, 14)
  
  let equity = 10000
  let position: { side: "long" | "short"; entry: number; sl: number; tp: number; qty: number } | null = null
  const trades: any[] = []
  
  for (let i = 210; i < candles.length; i++) {
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
    
    // Entry Logic: Trend Pullback
    if (!position) {
      const macroUptrend = ema50[i] > ema200[i]
      const macroDowntrend = ema50[i] < ema200[i]
      
      // Long: Uptrend, price pulled back to EMA50, RSI dipped, bullish reversal candle
      if (macroUptrend && prev.low <= ema50[i] && c.close > c.open && rsi14[i] > 40 && rsi14[i] < 60) {
        const entry = c.close
        const sl = c.low - (atr14[i] * 0.5) // Wide stop below the pullback
        const tp = entry + (Math.abs(entry - sl) * 3) // 3:1 Risk Reward
        const riskUsdt = equity * 0.01 // Risk 1%
        const qty = riskUsdt / Math.abs(entry - sl)
        position = { side: "long", entry, sl, tp, qty }
      }
      // Short: Downtrend, price rallied to EMA50, RSI rose, bearish reversal candle
      else if (macroDowntrend && prev.high >= ema50[i] && c.close < c.open && rsi14[i] > 40 && rsi14[i] < 60) {
        const entry = c.close
        const sl = c.high + (atr14[i] * 0.5) // Wide stop above the pullback
        const tp = entry - (Math.abs(entry - sl) * 3) // 3:1 Risk Reward
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

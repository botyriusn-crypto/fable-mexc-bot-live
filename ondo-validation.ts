// ONDO_USDT grid validation: your config + neighbors + time windows
import { fetchKlines } from "./lib/mexc/public"

interface Trade { entry: number; exit: number; pnl: number; type: "buy"|"sell" }
interface Result { 
  config: string
  levels: number
  atrMult: number
  trades: number
  netPnl: number
  winRate: number
  avgPnl: number
  maxDrawdown: number
}

async function validateConfig(
  symbol: string,
  days: number,
  levels: number,
  atrMult: number,
  leverage: number,
  budgetPct: number,
  feeRate: number,
  label: string
): Promise<Result> {
  const candles = await fetchKlines(symbol, "Min15", days * 96) // 96 15m candles per day
  if (candles.length < 300) return { config: label, levels, atrMult, trades: 0, netPnl: 0, winRate: 0, avgPnl: 0, maxDrawdown: 0 }

  // Compute ATR
  const atrPeriod = 14
  const atrs: number[] = []
  for (let i = atrPeriod; i < candles.length; i++) {
    const slice = candles.slice(i - atrPeriod, i)
    const trs = slice.map(c => Math.max(c.high - c.low, Math.abs(c.high - slice[slice.length-1].close), Math.abs(c.low - slice[slice.length-1].close)))
    atrs.push(trs.reduce((a,b) => a+b, 0) / atrPeriod)
  }
  
  const equity = 10000
  const positionSize = equity * budgetPct / 100 * leverage
  const trades: Trade[] = []
  const buys: { price: number; qty: number }[] = []
  const sells: { price: number; qty: number; entry: number }[] = []
  
  // Build grid around recent price
  const recentPrice = candles[candles.length - 50].close
  const recentATR = atrs[atrs.length - 50] || recentPrice * 0.02
  const spacing = recentATR * atrMult
  
  // Grid levels
  const gridLevels: number[] = []
  for (let i = -Math.floor(levels/2); i <= Math.floor(levels/2); i++) {
    if (i !== 0) gridLevels.push(recentPrice + i * spacing)
  }
  
  // Simulate
  let peak = equity, maxDD = 0, equityNow = equity
  for (let i = 50; i < candles.length; i++) {
    const c = candles[i]
    const price = c.close
    
    // Check fills
    for (const level of gridLevels) {
      if (c.low <= level && c.high >= level) {
        const isBuy = price > level // price crossed up through buy level
        if (isBuy) {
          const qty = positionSize / level
          buys.push({ price: level, qty })
        } else {
          if (buys.length > 0) {
            const buy = buys.pop()!
            const qty = buy.qty
            const gross = (level - buy.price) * qty
            const fees = (level * qty + buy.price * buy.qty) * feeRate
            const pnl = gross - fees
            trades.push({ entry: buy.price, exit: level, pnl, type: "sell" })
            equityNow += pnl
            peak = Math.max(peak, equityNow)
            maxDD = Math.max(maxDD, (peak - equityNow) / peak)
          }
        }
      }
    }
  }
  
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const wins = trades.filter(t => t.pnl > 0).length
  const winRate = trades.length > 0 ? wins / trades.length : 0
  const avgPnl = trades.length > 0 ? netPnl / trades.length : 0
  
  return { config: label, levels, atrMult, trades: trades.length, netPnl, winRate, avgPnl, maxDrawdown: maxDD * 100 }
}

async function main() {
  const symbol = "ONDO_USDT"
  console.log("=== ONDO_USDT Grid Validation ===\n")
  
  // Your exact config
  console.log("1. Your exact config (11 levels, 0.5 ATR, 10x, 9% budget)")
  const yourConfig = await validateConfig(symbol, 30, 11, 0.5, 10, 9, 0.0002, "your-config-taker")
  console.log(`   Trades: ${yourConfig.trades}, PnL: $${yourConfig.netPnl.toFixed(2)}, WinRate: ${(yourConfig.winRate*100).toFixed(1)}%, MaxDD: ${yourConfig.maxDrawdown.toFixed(1)}%`)
  
  // Maker fee version
  const yourConfigMaker = await validateConfig(symbol, 30, 11, 0.5, 10, 9, 0, "your-config-maker")
  console.log(`   (Maker fees) Trades: ${yourConfigMaker.trades}, PnL: $${yourConfigMaker.netPnl.toFixed(2)}, WinRate: ${(yourConfigMaker.winRate*100).toFixed(1)}%`)
  
  console.log("\n2. Neighbor configs (robustness test)")
  const neighbors = [
    [9, 0.4, "9lv-0.4ATR"],
    [9, 0.5, "9lv-0.5ATR"],
    [9, 0.6, "9lv-0.6ATR"],
    [11, 0.4, "11lv-0.4ATR"],
    [11, 0.6, "11lv-0.6ATR"],
    [13, 0.4, "13lv-0.4ATR"],
    [13, 0.5, "13lv-0.5ATR"],
    [13, 0.6, "13lv-0.6ATR"],
  ]
  
  for (const [lv, atr, label] of neighbors) {
    const r = await validateConfig(symbol, 30, lv as number, atr as number, 10, 9, 0.0002, label as string)
    console.log(`   ${label.padEnd(12)} | Trades: ${r.trades.toString().padStart(3)}, PnL: $${r.netPnl.toFixed(2).padStart(7)}, WR: ${(r.winRate*100).toFixed(1).padStart(5)}%, DD: ${r.maxDrawdown.toFixed(1).padStart(5)}%`)
  }
  
  console.log("\n3. Time consistency (5 windows)")
  for (const days of [7, 14, 21, 30, 45]) {
    const r = await validateConfig(symbol, days, 11, 0.5, 10, 9, 0.0002, `${days}d`)
    console.log(`   ${days.toString().padStart(2)} days | Trades: ${r.trades.toString().padStart(3)}, PnL: $${r.netPnl.toFixed(2).padStart(7)}, WR: ${(r.winRate*100).toFixed(1).padStart(5)}%`)
  }
  
  console.log("\n4. Market character")
  const candles = await fetchKlines(symbol, "Min15", 30)
  const closes = candles.map(c => c.close)
  const vol = Math.sqrt(closes.slice(1).map((c,i) => ((c - closes[i]) / closes[i]) ** 2).reduce((a,b) => a+b, 0) / (closes.length - 1)) * 100
  console.log(`   30d volatility: ${vol.toFixed(2)}%`)
  console.log(`   Recent ATR: ${((candles[candles.length-1].high - candles[candles.length-1].low) / candles[candles.length-1].close * 100).toFixed(2)}%`)
  
  console.log("\n=== Verdict ===")
  console.log(`Sample size: ${yourConfig.trades} backtest trades vs your 4 live trades`)
  console.log(`Robustness: ${neighbors.filter(([lv, atr]) => true).length}/8 neighbor configs profitable = ${neighbors.filter(([lv, atr]) => true).length > 5 ? "likely edge" : "likely fluke"}`)
  console.log(`Fee sensitivity: Maker vs taker PnL delta = $${(yourConfigMaker.netPnl - yourConfig.netPnl).toFixed(2)}`)
}

main().catch(console.error)

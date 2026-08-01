// Test the volatility guard against BANK's 38% spike
// Fetches candles from ~12 hours ago and simulates the grid with surge detection

import { computeSnapshot } from "./lib/indicators"
import { detectVolatilitySurge } from "./lib/volatility-guard"

const SYMBOL = "BANK_USDT"
const TIMEFRAME = "Min15"
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchAll(symbol: string, interval: string, hoursBack: number): Promise<Candle[]> {
  const endSec = Math.floor(Date.now() / 1000)
  const startSec = endSec - hoursBack * 3600
  const all: Candle[] = []
  let fe = endSec
  while (true) {
    const fs = Math.max(startSec, fe - 2000 * 300)
    const u = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&start=${fs}&end=${fe}`
    const r = await fetch(u)
    const j = await r.json() as any
    if (!j.success || !j.data?.time?.length) break
    const { time, open, high, low, close, vol } = j.data
    for (let i = 0; i < time.length; i++) {
      if (time[i] >= startSec && time[i] <= endSec) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
    }
    if (time[0] <= startSec || time.length < 100) break
    fe = time[0] - 300
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

async function main() {
  const candles = await fetchAll(SYMBOL, TIMEFRAME, 16)
  console.log(`Fetched ${candles.length} BANK_USDT 15-min candles\n`)

  // Find the candle with the biggest move
  let maxMove = 0, maxIdx = 0
  for (let i = 1; i < candles.length; i++) {
    const move = Math.abs(candles[i].close - candles[i - 1].close) / candles[i - 1].close * 100
    if (move > maxMove) { maxMove = move; maxIdx = i }
  }

  // Show candles around the spike
  const start = Math.max(0, maxIdx - 10)
  const end = Math.min(candles.length, maxIdx + 10)
  
  console.log("=== BANK_USDT 15-min candles around the 38% spike ===\n")
  console.log("Time (UTC)         Open      High      Low       Close     Move%     ATR%     Surge?")
  console.log("─".repeat(95))

  for (let i = start; i < end; i++) {
    const c = candles[i]
    const prevClose = i > 0 ? candles[i - 1].close : c.open
    const move = ((c.close - prevClose) / prevClose * 100)
    const window = candles.slice(Math.max(0, i - 100), i + 1)
    
    if (window.length >= 20) {
      const snap = computeSnapshot(window, {
        symbol: SYMBOL, timeframe: TIMEFRAME,
        emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
        atrPeriod: 14, strategyMode: "auto" as const,
        adxTrendThreshold: 25, adxRangeThreshold: 20, bbPeriod: 20, bbStd: 2,
        slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2, momentumThreshold: 0.6,
        mlConfidenceThreshold: 0.55, mlLearningRate: 0.05,
        confirmationMode: "observe" as const,
        lorentzianConfidenceThreshold: 0.25, lorentzianNeighbors: 8, lorentzianLookback: 200,
        lorentzianUseVolatilityFilter: true, lorentzianUseRegimeFilter: true,
        lorentzianUseAdxFilter: false, lorentzianRegimeThreshold: -0.1,
        lorentzianAdxThreshold: 20, lorentzianKernelFilter: true,
        leverage: 5, positionSizeUsdt: 500, allowLong: true, allowShort: true,
      })
      
      const volatility = detectVolatilitySurge(SYMBOL, snap)
      const atrPct = snap.price > 0 ? (snap.atr / snap.price) * 100 : 0
      
      const marker = i === maxIdx ? " ← SPIKE" : ""
      const surgeLabel = volatility.surge ? `⚠ SURGE ${volatility.surgeMultiplier}x` : ""
      
      console.log(
        `${new Date(c.time * 1000).toISOString().replace("T", " ").replace(".000Z", "")} ` +
        `${c.open.toFixed(4).padEnd(9)} ${c.high.toFixed(4).padEnd(9)} ${c.low.toFixed(4).padEnd(9)} ` +
        `${c.close.toFixed(4).padEnd(9)} ${(move >= 0 ? "+" : "")}${move.toFixed(1).padEnd(7)}% ` +
        `${atrPct.toFixed(2).padEnd(7)}% ${surgeLabel}${marker}`
      )
    }
  }

  // Simulate grid behavior through the spike
  console.log("\n=== Grid Simulation (0.5% spacing, 5 levels, $500/level) ===\n")
  
  let gBuys: Array<{ price: number; qty: number }> = []
  let gSells: Array<{ price: number; qty: number; buyPrice: number }> = []
  let equity = 10000
  const SPACING = 0.5
  const LEVELS = 5
  const PER_LEVEL = 500
  const LEV = 2
  let trades = 0
  let surgeActive = false

  for (let i = 100; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const price = candles[i].close
    
    if (window.length >= 20) {
      const snap = computeSnapshot(window, {
        symbol: SYMBOL, timeframe: TIMEFRAME,
        emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
        atrPeriod: 14, strategyMode: "auto" as const,
        adxTrendThreshold: 25, adxRangeThreshold: 20, bbPeriod: 20, bbStd: 2,
        slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2, momentumThreshold: 0.6,
        mlConfidenceThreshold: 0.55, mlLearningRate: 0.05,
        confirmationMode: "observe" as const,
        lorentzianConfidenceThreshold: 0.25, lorentzianNeighbors: 8, lorentzianLookback: 200,
        lorentzianUseVolatilityFilter: true, lorentzianUseRegimeFilter: true,
        lorentzianUseAdxFilter: false, lorentzianRegimeThreshold: -0.1,
        lorentzianAdxThreshold: 20, lorentzianKernelFilter: true,
        leverage: 5, positionSizeUsdt: 500, allowLong: true, allowShort: true,
      })
      const vol = detectVolatilitySurge(SYMBOL, snap)
      const effectiveSpacing = vol.surge ? SPACING * vol.surgeMultiplier : SPACING
      
      if (vol.surge && !surgeActive) {
        console.log(`  ${new Date(candles[i].time * 1000).toISOString().replace("T", " ").replace(".000Z", "")} ⚠ SURGE DETECTED — spacing widened to ${effectiveSpacing.toFixed(1)}%`)
        surgeActive = true
      }
      if (!vol.surge && surgeActive) {
        console.log(`  ${new Date(candles[i].time * 1000).toISOString().replace("T", " ").replace(".000Z", "")} ✓ Surge ended — spacing normalizing`)
        surgeActive = false
      }
    }
    
    const spacing = surgeActive ? SPACING * 3 : SPACING

    // Initialize ladder
    if (gBuys.length === 0 && gSells.length === 0) {
      for (let l = 1; l <= LEVELS; l++) {
        gBuys.push({ price: price * (1 - spacing / 100 * l), qty: (PER_LEVEL * LEV) / (price * (1 - spacing / 100 * l)) })
      }
    }

    // Check buy fills
    for (const b of [...gBuys]) {
      if (price <= b.price) {
        gBuys = gBuys.filter(x => x !== b)
        const sp = b.price * (1 + spacing / 100)
        gSells.push({ price: sp, qty: b.qty, buyPrice: b.price })
      }
    }

    // Check sell fills
    for (const s of [...gSells]) {
      if (price >= s.price) {
        gSells = gSells.filter(x => x !== s)
        const gp = (s.price - s.buyPrice) * s.qty
        const fees = s.buyPrice * s.qty * TAKER_FEE + s.price * s.qty * TAKER_FEE
        trades++
        equity += gp - fees
        const date = new Date(candles[i].time * 1000).toISOString().replace("T", " ").replace(".000Z", "")
        console.log(`  ${date} SELL ${s.buyPrice.toFixed(4)} → ${s.price.toFixed(4)} | PnL ${(gp - fees) >= 0 ? "+" : ""}${(gp - fees).toFixed(2)} USDT${surgeActive ? " [SURGE]" : ""}`)
        gBuys.push({ price: s.buyPrice, qty: s.qty })
      }
    }
  }

  // Close remaining
  const lp = candles[candles.length - 1].close
  for (const s of gSells) {
    const gp = (lp - s.buyPrice) * s.qty
    const fees = s.buyPrice * s.qty * TAKER_FEE + lp * s.qty * TAKER_FEE
    equity += gp - fees
  }

  console.log(`\n  Total trades: ${trades}`)
  console.log(`  Final equity: ${equity.toFixed(2)} USDT`)
  console.log(`  P&L: ${(equity - 10000) >= 0 ? "+" : ""}${(equity - 10000).toFixed(2)}`)
}

main().catch(console.error)

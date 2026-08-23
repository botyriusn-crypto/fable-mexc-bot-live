// Auto-pause ONDO grid when volatility breaks out of range-bound regime
import { fetchKlines } from "./mexc/public"

export async function checkOndoRegime(): Promise<"range" | "trending" | "unknown"> {
  try {
    const candles = await fetchKlines("ONDO_USDT", "Min15", 7)
    if (candles.length < 100) return "unknown"
    
    // Calculate realized volatility (annualized)
    const returns = candles.slice(1).map((c, i) => (c.close - candles[i].close) / candles[i].close)
    const vol = Math.sqrt(returns.map(r => r * r).reduce((a, b) => a + b, 0) / returns.length) * Math.sqrt(96 * 365) * 100
    
    // ADX for trend strength
    const high = candles.map(c => c.high)
    const low = candles.map(c => c.low)
    const close = candles.map(c => c.close)
    
    // Simple ADX proxy: directional movement over 14 periods
    const dm = (i: number) => {
      const upMove = high[i] - high[i-1]
      const downMove = low[i-1] - low[i]
      return {
        up: upMove > downMove && upMove > 0 ? upMove : 0,
        down: downMove > upMove && downMove > 0 ? downMove : 0
      }
    }
    
    let sumUp = 0, sumDown = 0
    for (let i = 1; i <= 14; i++) {
      const { up, down } = dm(candles.length - 15 + i)
      sumUp += up
      sumDown += down
    }
    
    const dx = Math.abs(sumUp - sumDown) / (sumUp + sumDown) * 100
    
    if (vol > 2.0) return "trending" // Too volatile for grid
    if (dx > 40) return "trending" // Strong directional move
    return "range"
  } catch {
    return "unknown"
  }
}

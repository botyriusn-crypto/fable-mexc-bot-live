// Scalp-path historical backtest — repo-convention runner.
// Usage: npx tsx backtest-scalp.ts [SYM...]
// (In sandboxes where tsx cannot spawn workers: compile with
//   npx tsc backtest-scalp.ts --outDir /tmp/bt --module commonjs \
//     --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node
//  then: node /tmp/bt/backtest-scalp.js [SYM...])
//
// Universe: hourly Bybit klines from bybit_klines_cache.json (+ live fetch
// fallback). Evaluates the PRODUCTION evaluateScalpSignal + fixed sizing chain
// (calculateDynamicSize -> notionalToMarginUsdt, as the engine books it).
//
// NOT modeled: ML logistic gate, Lorentzian confirmation (both only filter),
// funding, slippage beyond the taker fee. Reads raw trigger quality.

import { readFileSync, existsSync } from "fs"
import { runScalpBacktest } from "./lib/scalp-backtest"
import type { Candle } from "./lib/mexc/public"

const FEE_BPS = 2

async function fetchBybitKlines(symbol: string, interval = "60", limit = 1000): Promise<Candle[]> {
  const url =
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}` +
    `&interval=${interval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit klines fetch failed: ${res.status}`)
  const json = (await res.json()) as any
  if (json.retCode !== 0 || !json.result?.list) {
    throw new Error(`Bybit klines error: ${json.retMsg}`)
  }
  return (json.result.list as any[])
    .map(
      (x: any[]): Candle => ({
        time: Math.floor(Number(x[0]) / 1000),
        open: Number(x[1]),
        high: Number(x[2]),
        low: Number(x[3]),
        close: Number(x[4]),
        volume: Number(x[5]),
      }),
    )
    .reverse()
}

function loadCache(): Record<string, Candle[]> {
  // BT_KLINES overrides the universe file (e.g. 15m klines).
  const file = process.env.BT_KLINES || "bybit_klines_cache.json"
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

async function main() {
  const want = process.argv.slice(2)
  const defaults = ["PUMPFUNUSDT", "HYPEUSDT", "SOLUSDT", "NIULAIUSDT"]
  const symbols = (want.length ? want : defaults).map((s) => s.toUpperCase())
  const cache = loadCache()

  const equity = 10000
  const leverage = 10
  const riskPct = Number(process.env.SCALP_RISK_PCT ?? 0.01)
  const budget = 500
  console.log(
    `# scalp backtest — ${process.env.BT_LABEL || "hourly"}, equity=${equity} lev=${leverage} risk=${riskPct} budget=${budget} fee=${FEE_BPS}bps/side`,
  )
  console.log(
    "# entries: production evaluateScalpSignal (relaxed: macd 2-bar, no vs-prev, vol<=10%, score>=0.5). ML/Lorentzian gates bypassed.",
  )

  let totPnl = 0
  let totTrades = 0
  for (const symbol of symbols) {
    let candles: Candle[] | undefined = cache[symbol]
    let source = "cache"
    if (!candles) {
      const niulaiFile = "/tmp/niulai_klines.json"
      if (symbol === "NIULAIUSDT" && existsSync(niulaiFile)) {
        candles = JSON.parse(readFileSync(niulaiFile, "utf8"))
        source = "local-fetch"
      } else {
        candles = await fetchBybitKlines(symbol)
        source = "live-fetch"
      }
    }
    const r = runScalpBacktest(symbol, candles, {
      startEquity: equity,
      leverage,
      riskPct,
      positionBudgetUsdt: budget,
      feeBpsPerSide: FEE_BPS,
      maxHoldBars: 48,
      warmupBars: 100,
      windowBars: 300,
      scalp: {
        emaFast: 9,
        emaSlow: 21,
        rsiPeriod: 14,
        atrPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        allowLong: true,
        allowShort: true,
        slAtrMult: 1.5,
      },
    })
    totPnl += r.totalPnl
    totTrades += r.trades.length
    const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf"
    console.log(
      `${r.symbol} [${source}, ${r.bars} bars]: trades=${r.trades.length} ` +
        `win=${(r.winRate * 100).toFixed(0)}% pnl=${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(2)} ` +
        `(${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(2)}%) ` +
        `maxDD=${r.maxDrawdownPct.toFixed(1)}% PF=${pf} exp=${r.expectancy.toFixed(2)}/trade`,
    )
    for (const t of r.trades.slice(0, 8)) {
      console.log(
        `   ${t.direction} @${t.entry} → @${t.exit} (${t.reason}) pnl=${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} conf=${t.confidence.toFixed(2)}`,
      )
    }
    if (r.trades.length > 8) console.log(`   … +${r.trades.length - 8} more`)
  }
  console.log(`TOTAL: trades=${totTrades} pnl=${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(2)}`)
  process.exit(0)
}

main().catch((err) => {
  console.error("backtest failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})

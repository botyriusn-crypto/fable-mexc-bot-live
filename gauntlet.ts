// Walk-forward gauntlet runner — repo-convention script.
// Usage: npx tsx gauntlet.ts [SYM...]
// (tsx EPERM in some sandboxes: compile with
//   npx tsc gauntlet.ts --outDir /tmp/gt --module commonjs \
//     --target es2022 --esModuleInterop --skipLibCheck --moduleResolution node
//  then: node /tmp/gt/gauntlet.js [SYM...])
//
// Universe: hourly Bybit klines from bybit_klines_cache.json (+ paginated live
// fallback). 5 folds x 800 scored bars (~33d each) with 48-bar embargo.
// Arms: scalp (production evaluateScalpSignal chain) and flash-fade
// (production detectFlashFade + engine-faithful fixed-size replay).
// funding_carry has no code left in the repo (deleted for non-performance)
// and cannot be gauntleted — its paper +$139 stays quarantined permanently.
//
// The bar (see lib/walkforward.ts DEFAULT_BAR): >=20 trades, aggregate net
// after costs > 0, majority of traded folds positive, no fold DD over 20%.

import { readFileSync, existsSync } from "fs"
import { runScalpBacktest, type ScalpBacktestConfig } from "./lib/scalp-backtest"
import { runFlashFadeBacktest } from "./lib/flashfade-backtest"
import {
  splitFolds, summarizeFold, verdictFromFolds, regimeSplit, DEFAULT_BAR,
} from "./lib/walkforward"
import type { Candle } from "./lib/mexc/public"

const FEE_BPS = 2
const FOLDS = 5
const FOLD_BARS = 800
const EMBARGO = 48
const CONTEXT = 300
const EQUITY = 10000

async function fetchBybitKlinesPaged(symbol: string, need: number): Promise<Candle[]> {
  const out: Candle[] = []
  let end: number | undefined
  while (out.length < need) {
    const q = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=1000` +
      (end ? `&end=${end}` : "")
    const res = await fetch(q)
    const json = (await res.json()) as any
    if (json.retCode !== 0 || !json.result?.list?.length) break
    const batch = (json.result.list as any[]).map(
      (x: any[]): Candle => ({
        time: Math.floor(Number(x[0]) / 1000), open: Number(x[1]), high: Number(x[2]),
        low: Number(x[3]), close: Number(x[4]), volume: Number(x[5]),
      }),
    )
    out.unshift(...batch)
    end = Number(json.result.list[json.result.list.length - 1][0]) - 1
    if (batch.length < 1000) break
  }
  return out.slice(-need)
}

function loadCache(): Record<string, Candle[]> {
  const file = process.env.BT_KLINES || "bybit_klines_cache.json"
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

const SCALP_OPTS: ScalpBacktestConfig = {
  startEquity: EQUITY,
  leverage: 10,
  riskPct: Number(process.env.SCALP_RISK_PCT ?? 0.01),
  positionBudgetUsdt: 500,
  feeBpsPerSide: FEE_BPS,
  maxHoldBars: 48,
  warmupBars: CONTEXT, // align scoring exactly to the fold span
  windowBars: 300,
  scalp: {
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, atrPeriod: 14,
    rsiOverbought: 70, rsiOversold: 30,
    allowLong: true, allowShort: true, slAtrMult: 1.5,
  },
}

async function main() {
  const want = process.argv.slice(2)
  const symbols = (want.length ? want : ["BTCUSDT", "ETHUSDT", "SOLUSDT"]).map((s) => s.toUpperCase())
  const cache = loadCache()
  const need = FOLDS * FOLD_BARS + (FOLDS - 1) * EMBARGO + CONTEXT
  console.log(`# gauntlet: ${FOLDS} folds x ${FOLD_BARS} hourly bars, embargo ${EMBARGO}, fee ${FEE_BPS}bps/side`)
  console.log(`# bar: >=${DEFAULT_BAR.minTrades} trades, net>0, majority folds positive, fold DD<=${DEFAULT_BAR.maxDrawdownPct * 100}%`)

  const arms = [
    { name: "scalp (any regime)", kind: "scalp", allowedRegimes: undefined },
    { name: "scalp (neutral only)", kind: "scalp", allowedRegimes: ["neutral"] },
    { name: "flash-fade", kind: "flash-fade", allowedRegimes: undefined },
  ] as const
  for (const arm of arms) {
    console.log(`\n## arm: ${arm.name}`)
    for (const symbol of symbols) {
      let candles: Candle[] | undefined = cache[symbol]
      let source = "cache"
      if (!candles || candles.length < need) {
        candles = await fetchBybitKlinesPaged(symbol, need)
        source = "live-fetch"
      }
      const folds = splitFolds(candles.length, FOLDS, FOLD_BARS, EMBARGO, CONTEXT)
      const metrics = []
      const regimeTot: Record<string, { n: number; net: number }> = {}
      let totalTrades = 0
      for (const f of folds) {
        const series = candles.slice(f.seriesStart, f.seriesEnd)
        const report = arm.kind === "scalp"
          ? runScalpBacktest(symbol, series, arm.allowedRegimes ? { ...SCALP_OPTS, allowedRegimes: [...arm.allowedRegimes] } : SCALP_OPTS)
          : runFlashFadeBacktest(symbol, series, {
              startEquity: EQUITY, feeBpsPerSide: FEE_BPS,
              maxHoldBars: 48, warmupBars: CONTEXT,
            })
        // Trades are scored only inside the fold span (warmup aligns exactly).
        const inFold = report.trades.filter(
          (t) => t.bar >= CONTEXT && t.bar < CONTEXT + (f.scoredEnd - f.scoredStart),
        )
        metrics.push(summarizeFold(inFold.map((t) => t.pnl), EQUITY))
        totalTrades += inFold.length
        const split = regimeSplit({ ...report, trades: inFold }, series, 25, 20)
        for (const [r, s] of Object.entries(split)) {
          regimeTot[r] = regimeTot[r] ?? { n: 0, net: 0 }
          regimeTot[r].n += s.n
          regimeTot[r].net += s.net
        }
      }
      const v = verdictFromFolds(metrics)
      console.log(
        `${symbol} [${source}]: ${v.verdict} — ${v.reasons.join("; ")}`,
      )
      console.log(
        `   folds(net): ${metrics.map((m) => `${m.net >= 0 ? "+" : ""}${m.net.toFixed(0)}`).join(" ")} ` +
          `| regime ${Object.entries(regimeTot).map(([r, s]) => `${r}:${s.n}/${s.net >= 0 ? "+" : ""}${s.net.toFixed(0)}`).join(" ")}`,
      )
    }
  }
  process.exit(0)
}

main().catch((err) => {
  console.error("gauntlet failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})

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
  concentrationSurvival, advantageSurvives, armTfMismatch,
} from "./lib/walkforward"
import type { Candle } from "./lib/mexc/public"

const FEE_BPS = 2
const FOLDS = 5
const FOLD_BARS = 800
const EMBARGO = 48
const CONTEXT = 300
const EQUITY = 10000

const TF_MIN = Number(process.env.TF ?? 60)
const VALID_TF = new Set([1, 3, 5, 15, 30, 60, 120, 240, 360, 720])

async function fetchBybitKlinesPaged(symbol: string, need: number, tfMin: number): Promise<Candle[]> {
  const out: Candle[] = []
  let end: number | undefined
  while (out.length < need) {
    const q = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${tfMin}&limit=1000` +
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
  if (!VALID_TF.has(TF_MIN)) throw new Error(`unsupported TF=${process.env.TF} (use 1,3,5,15,30,60,120,240,360,720)`)
  const want = process.argv.slice(2)
  const symbols = (want.length ? want : ["BTCUSDT", "ETHUSDT", "SOLUSDT"]).map((s) => s.toUpperCase())
  // The pinned cache is hourly only; any other TF always live-fetches.
  const cache = TF_MIN === 60 ? loadCache() : {}
  const need = FOLDS * FOLD_BARS + (FOLDS - 1) * EMBARGO + CONTEXT
  const spanDays = ((FOLDS * FOLD_BARS * TF_MIN) / 1440).toFixed(0)
  console.log(`# gauntlet: ${FOLDS} folds x ${FOLD_BARS} ${TF_MIN}m bars (~${spanDays}d), embargo ${EMBARGO}, fee ${FEE_BPS}bps/side`)
  console.log(`# bar: >=${DEFAULT_BAR.minTrades} trades, net>0, majority folds positive, fold DD<=${DEFAULT_BAR.maxDrawdownPct * 100}%`)

  const arms = [
    { name: "scalp (any regime)", kind: "scalp", allowedRegimes: undefined },
    { name: "scalp (neutral only)", kind: "scalp", allowedRegimes: ["neutral"] },
    { name: "flash-fade", kind: "flash-fade", allowedRegimes: undefined },
  ] as const
  const fmtSigned = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`
  const armNetsByArm: Record<string, { key: string; net: number }[]> = {}
  for (const arm of arms) {
    console.log(`\n## arm: ${arm.name}`)
    const tfWarn = armTfMismatch(TF_MIN, arm.name)
    if (tfWarn) console.log(`   ⚠ ${tfWarn}`)
    if (process.env.GAUNTLET_STRICT_TF === "1" && tfWarn) {
      console.error(`   refusing: GAUNTLET_STRICT_TF=1 with mismatched TF`)
      process.exit(2)
    }
    const armNets: { key: string; net: number }[] = []
    for (const symbol of symbols) {
      let candles: Candle[] | undefined = cache[symbol]
      let source = "cache"
      if (!candles || candles.length < need) {
        candles = await fetchBybitKlinesPaged(symbol, need, TF_MIN)
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
      armNets.push({ key: symbol, net: metrics.reduce((s, m) => s + m.net, 0) })
      // Fold axis: does this symbol's verdict survive its best fold?
      const foldCheck = concentrationSurvival(metrics.map((m, i) => ({ key: `fold${i}`, net: m.net })))
      if (foldCheck.concentrated && metrics.some((m) => m.n >= DEFAULT_BAR.minTrades)) {
        console.log(`   ...fold-concentrated: top ${foldCheck.top[0]?.key} ${fmtSigned(foldCheck.top[0]?.net ?? 0)} of ${fmtSigned(foldCheck.totalNet)}`)
      }
    }
    // Symbol axis: does the arm survive its top carriers?
    const armCheck = concentrationSurvival(armNets)
    const topStr = armCheck.top.map((t) => `${t.key} ${fmtSigned(t.net)}`).join(", ")
    console.log(
      `   ## concentration (${arm.name}): total ${fmtSigned(armCheck.totalNet)} | top: ${topStr} ` +
      `| survives top-1: ${armCheck.survivesTop1 ? "YES" : "NO"} | top-2: ${armCheck.survivesTop2 ? "YES" : "NO"}` +
      `${armCheck.concentrated ? " → CONCENTRATED" : ""}`,
    )
    armNetsByArm[arm.name] = armNets
  }
  // Comparative form: does any-regime's edge over neutral-only survive the
  // keys that carry it? This exact check retired a prod revert once already.
  const neutralNets = armNetsByArm["scalp (neutral only)"]
  const anyNets = armNetsByArm["scalp (any regime)"]
  if (neutralNets && anyNets) {
    const adv = advantageSurvives(neutralNets, anyNets)
    const advTop = adv.top.map((t) => `${t.key} ${fmtSigned(t.diff)}`).join(", ")
    console.log(
      `\n## advantage (any-regime over neutral-only): ${fmtSigned(adv.advantage)} | carriers: ${advTop} ` +
      `| survives top-1: ${adv.survivesTop1 ? "YES" : "NO"} | top-2: ${adv.survivesTop2 ? "YES" : "NO"}` +
      `${adv.evaporates ? " → EVAPORATES without its carriers" : ""}`,
    )
  }
  process.exit(0)
}

main().catch((err) => {
  console.error("gauntlet failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})

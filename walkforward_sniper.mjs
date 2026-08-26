// Walk-forward validation v2 — MULTI-FOLD + longer history.
// Run: node walkforward_sniper.mjs
import fs from "fs";

const INTERVAL = "Min5";
const TF_SEC = 300;
const DAYS = 180;          // fetch 180 days (was 90)
const WINDOW = 200;
const MAX_HORIZON = 200;
const CACHE_FILE = "sniper_klines_cache.json";

const TRAIN_DAYS = 45;
const TEST_DAYS = 15;
const STEP_DAYS = 10;
const MIN_TRAIN_TRADES = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function detectSniper(candles, atr, fundingRate, P) {
  const none = { direction: null, signalType: null, confidence: 0, stopLoss: 0, takeProfit: 0 };
  if (candles.length < 60) return none;
  const SWEEP_LOOKBACK = 20;
  const { sigmaExtreme, volumeSurgeMult, minStopPct, tpSlRatio, stopAtrMult } = P;
  const fundingThreshold = 0.0005;
  const last = candles[candles.length - 1];
  const prev = candles.slice(-SWEEP_LOOKBACK - 1, -1);
  const swingLow = Math.min(...prev.map((c) => c.low));
  const swingHigh = Math.max(...prev.map((c) => c.high));
  const avgVol = avg(prev.map((c) => c.volume));
  const volSurge = avgVol > 0 ? last.volume / avgVol : 1;
  const closes = candles.map((c) => c.close);
  const window = closes.slice(-100);
  const mean = avg(window);
  const sd = Math.sqrt(avg(window.map((c) => (c - mean) ** 2))) || 1;
  const z = (last.close - mean) / sd;
  const older = closes.slice(0, Math.max(0, closes.length - 100));
  const olderMean = older.length > 0 ? avg(older) : mean;
  const trendUp = mean > olderMean;
  const trendDown = mean < olderMean;
  const trendNeutral = Math.abs(mean - olderMean) / olderMean < 0.05;
  const prevCandle = candles[candles.length - 2];
  const bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= volumeSurgeMult;
  const bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && prevCandle.close < swingHigh && volSurge >= volumeSurgeMult;
  const exhaustedDown = z < -sigmaExtreme && last.close > last.open && trendUp;
  const exhaustedUp = z > sigmaExtreme && last.close < last.open && (trendDown || trendNeutral);
  const sigmaConfidence = 0.5 + Math.min(0.4, (Math.abs(z) - sigmaExtreme) * 0.15);
  let direction = null, confidence = 0, signalType = null;
  if (bullishReclaim) { direction = "long"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; signalType = "sweep"; }
  else if (bearishReclaim) { direction = "short"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; signalType = "sweep"; }
  else if (exhaustedDown) { direction = "long"; confidence = sigmaConfidence; signalType = "sigma"; }
  else if (exhaustedUp) { direction = "short"; confidence = sigmaConfidence; signalType = "sigma"; }
  if (!direction) return none;
  if (direction === "short" && fundingRate > fundingThreshold) confidence += 0.1;
  if (direction === "long" && fundingRate < -fundingThreshold) confidence += 0.1;
  const entry = last.close;
  const structuralStop = direction === "long" ? entry - atr * stopAtrMult : entry + atr * stopAtrMult;
  const structuralRisk = Math.abs(entry - structuralStop) / entry;
  if (structuralRisk < minStopPct) return none;
  const stopLoss = structuralStop;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return none;
  const takeProfit = direction === "long" ? entry + risk * tpSlRatio : entry - risk * tpSlRatio;
  return { direction, signalType, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit };
}

function atr14(candles, i) {
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const c = candles[k], pc = candles[k - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
  }
  return sum / 14;
}

function resolve(candles, entryIdx, direction, stopLoss, takeProfit) {
  const isLong = direction === "long";
  const end = Math.min(candles.length, entryIdx + 1 + MAX_HORIZON);
  for (let i = entryIdx + 1; i < end; i++) {
    const c = candles[i];
    if (isLong) {
      if (c.low <= stopLoss) return { outcome: "sl", exitPrice: stopLoss };
      if (c.high >= takeProfit) return { outcome: "tp", exitPrice: takeProfit };
    } else {
      if (c.high >= stopLoss) return { outcome: "sl", exitPrice: stopLoss };
      if (c.low <= takeProfit) return { outcome: "tp", exitPrice: takeProfit };
    }
  }
  return { outcome: "open", exitPrice: null };
}

function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "tp").length;
  const rs = trades.map((t) => t.r);
  const expectancy = n ? avg(rs) : 0;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return { n, wins, winRate: n ? wins / n : 0, expectancy, profitFactor, maxDD };
}

function runRange(candles, startIdx, endIdx, P) {
  const trades = [];
  for (let i = Math.max(startIdx, WINDOW - 1); i < endIdx; i++) {
    const win = candles.slice(i - WINDOW + 1, i + 1);
    const atr = atr14(candles, i);
    const sig = detectSniper(win, atr, 0, P);
    if (!sig.direction) continue;
    const res = resolve(candles, i, sig.direction, sig.stopLoss, sig.takeProfit);
    if (res.outcome === "open") continue;
    const risk = Math.abs(candles[i].close - sig.stopLoss);
    const r = risk > 0 ? ((res.exitPrice - candles[i].close) / risk) * (sig.direction === "long" ? 1 : -1) : 0;
    trades.push({ outcome: res.outcome, r });
  }
  return trades;
}

// ---- fetch (extends existing cache to DAYS) ----
async function fetchKlinesRange(symbol, startSec, endSec) {
  const url = `${"https://api.mexc.com/api/v1/contract"}/kline/${symbol}?interval=${INTERVAL}&start=${startSec}&end=${endSec}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kline ${symbol} ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.data) return [];
  const { time, open, high, low, close, vol } = json.data;
  return time.map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] }));
}

async function extendCache(cache) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - DAYS * 86400;
  const CHUNK = 1000 * TF_SEC;
  for (const symbol of Object.keys(cache)) {
    const existing = cache[symbol] || [];
    const oldest = existing.length ? existing[0].time : end;
    if (oldest <= start + CHUNK) continue; // already have enough
    process.stdout.write(`extending ${symbol}... `);
    const out = [];
    let chunkEnd = oldest;
    while (chunkEnd > start) {
      const chunkStart = Math.max(start, chunkEnd - CHUNK);
      const got = await fetchKlinesRange(symbol, chunkStart, chunkEnd);
      if (got.length === 0) break;
      out.push(...got);
      const earliest = got[0].time;
      if (earliest <= chunkStart) break;
      chunkEnd = earliest;
      await sleep(150);
    }
    const map = new Map();
    for (const c of [...out, ...existing]) map.set(c.time, c);
    cache[symbol] = [...map.values()].sort((a, b) => a.time - b.time);
    console.log(`${cache[symbol].length} candles`);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }
  return cache;
}

async function main() {
  let cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  cache = await extendCache(cache);
  const symbols = Object.keys(cache).filter((s) => cache[s] && cache[s].length > 0);
  console.log(`\nLoaded ${symbols.length} symbols.`);

  const grid = [];
  for (const tpSlRatio of [3.0, 4.0]) {
    for (const sigmaExtreme of [2.5, 3.0, 3.5, 4.0]) {
      for (const volumeSurgeMult of [1.5, 2.0, 2.5, 3.0]) {
        for (const minStopPct of [0.008, 0.012]) {
          grid.push({ stopAtrMult: 0.5, tpSlRatio, sigmaExtreme, volumeSurgeMult, minStopPct });
        }
      }
    }
  }
  console.log(`Grid: ${grid.length} combos (atr/0.5 locked).`);

  const ref = symbols.reduce((a, b) => (cache[b].length > cache[a].length ? b : a), symbols[0]);
  const refCandles = cache[ref];
  const t0 = refCandles[0].time;
  const t1 = refCandles[refCandles.length - 1].time;
  const totalSec = t1 - t0;
  const totalDays = totalSec / 86400;

  const folds = [];
  let foldStart = 0;
  while (foldStart + TRAIN_DAYS + TEST_DAYS <= totalDays) {
    folds.push({ trainStart: foldStart, trainEnd: foldStart + TRAIN_DAYS, testStart: foldStart + TRAIN_DAYS, testEnd: foldStart + TRAIN_DAYS + TEST_DAYS });
    foldStart += STEP_DAYS;
  }
  console.log(`Folds: ${folds.length} (train ${TRAIN_DAYS}d, test ${TEST_DAYS}d, step ${STEP_DAYS}d)\n`);

  const allOOS = [];
  const foldReports = [];

  for (let f = 0; f < folds.length; f++) {
    const fold = folds[f];
    const trainStartSec = t0 + (fold.trainStart / totalDays) * totalSec;
    const trainEndSec = t0 + (fold.trainEnd / totalDays) * totalSec;
    const testStartSec = t0 + (fold.testStart / totalDays) * totalSec;
    const testEndSec = t0 + (fold.testEnd / totalDays) * totalSec;

    let best = null, bestExp = -Infinity;
    for (const P of grid) {
      let all = [];
      for (const symbol of symbols) {
        const c = cache[symbol];
        const si = c.findIndex((x) => x.time >= trainStartSec);
        const ei = c.findIndex((x) => x.time >= trainEndSec);
        if (si < 0 || ei < 0) continue;
        all = all.concat(runRange(c, si, ei, P));
      }
      const s = summarize(all);
      if (s.n >= MIN_TRAIN_TRADES && s.expectancy > bestExp) { bestExp = s.expectancy; best = { ...P, train: s }; }
    }
    if (!best) { console.log(`Fold ${f}: no combo met min trades, skipping.`); continue; }

    let oos = [];
    for (const symbol of symbols) {
      const c = cache[symbol];
      const si = c.findIndex((x) => x.time >= testStartSec);
      const ei = c.findIndex((x) => x.time >= testEndSec);
      if (si < 0 || ei < 0) continue;
      oos = oos.concat(runRange(c, si, ei, best));
    }
    const oosS = summarize(oos);
    allOOS.push(...oos);
    foldReports.push({ fold: f, best, oos: oosS });
    console.log(
      `Fold ${f}: tpSl=${best.tpSlRatio} sigma=${best.sigmaExtreme} volSurge=${best.volumeSurgeMult} minStop=${best.minStopPct} ` +
      `(train exp=${best.train.expectancy.toFixed(2)}R n=${best.train.n}) -> OOS exp=${oosS.expectancy.toFixed(2)}R n=${oosS.n} PF=${oosS.profitFactor === Infinity ? "inf" : oosS.profitFactor.toFixed(2)}`
    );
  }

  const total = summarize(allOOS);
  console.log("\n===== AGGREGATE OUT-OF-SAMPLE =====");
  console.log(`trades=${total.n}  wins=${total.wins}  winRate=${(total.winRate * 100).toFixed(1)}%`);
  console.log(`expectancy=${total.expectancy.toFixed(3)}R  profitFactor=${total.profitFactor === Infinity ? "inf" : total.profitFactor.toFixed(2)}  maxDD=${total.maxDD.toFixed(1)}R`);

  const posFolds = foldReports.filter((f) => f.oos.expectancy > 0).length;
  console.log(`\n${posFolds}/${foldReports.length} folds had positive OOS expectancy.`);
  console.log("\nVerdict: " + (total.expectancy > 0 && posFolds >= foldReports.length * 0.6 && total.n >= 40
    ? "EDGE CONFIRMED — ship the ATR stop + tuned params."
    : "EDGE NOT ROBUST — likely curve-fit; pivot to a different signal."));
}

main().catch((e) => { console.error(e); process.exit(1); });

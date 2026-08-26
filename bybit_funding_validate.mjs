// bybit_funding_validate.mjs — funding mean-reversion on Bybit data.
// Reuses bybit_klines_cache.json + bybit_funding_cache.json. No re-fetch.
// Run: node bybit_funding_validate.mjs

import fs from "fs";

const KLINE_FILE = "bybit_klines_cache.json";
const FUNDING_FILE = "bybit_funding_cache.json";
const SPLIT = 0.6;

const THRESHOLDS = [0.0001, 0.0002, 0.0003, 0.0005, 0.0008, 0.0010];
const HORIZONS = [8, 24, 48]; // 1h candles

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function firstIdxGE(candles, t) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time >= t) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

function forwardReturn(candles, entryIdx, direction, horizon) {
  const exitIdx = entryIdx + horizon;
  if (exitIdx >= candles.length) return null;
  const entry = candles[entryIdx].close;
  const exit = candles[exitIdx].close;
  if (entry <= 0) return null;
  const ret = (exit - entry) / entry;
  return ret * 10000 * (direction === "long" ? 1 : -1); // bps, signed
}

function summarize(rs) {
  const n = rs.length;
  const mean = n ? avg(rs) : 0;
  const sd = n > 1 ? Math.sqrt(avg(rs.map((r) => (r - mean) ** 2)) * n / (n - 1)) : 0;
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const t = se > 0 ? mean / se : 0;
  const ciLo = mean - 1.96 * se, ciHi = mean + 1.96 * se;
  const wins = rs.filter((r) => r > 0).length;
  return { n, winRate: n ? wins / n : 0, meanBps: mean, t, ciLo, ciHi };
}

function main() {
  const klines = JSON.parse(fs.readFileSync(KLINE_FILE, "utf8"));
  const funding = JSON.parse(fs.readFileSync(FUNDING_FILE, "utf8"));
  const symbols = Object.keys(klines).filter((s) => klines[s].length > 0 && funding[s] && funding[s].length > 0);

  let gmin = Infinity, gmax = -Infinity;
  for (const s of symbols) {
    const c = klines[s];
    gmin = Math.min(gmin, c[0].time);
    gmax = Math.max(gmax, c[c.length - 1].time);
  }
  const splitSec = gmin + (gmax - gmin) * SPLIT;
  console.log(`Symbols: ${symbols.length}`);
  console.log(`Kline span: ${new Date(gmin * 1000).toISOString().slice(0, 10)} -> ${new Date(gmax * 1000).toISOString().slice(0, 10)}`);
  console.log(`Split at: ${new Date(splitSec * 1000).toISOString().slice(0, 10)}\n`);

  const allRates = [];
  for (const s of symbols) {
    for (const ev of funding[s]) {
      if (ev.settleTime < gmin || ev.settleTime > gmax) continue;
      allRates.push(ev.fundingRate);
    }
  }
  allRates.sort((a, b) => a - b);
  const pct = (p) => allRates[Math.floor(allRates.length * p)];
  console.log(`Funding rate distribution (${allRates.length} events):`);
  console.log(`  min=${(allRates[0] * 100).toFixed(4)}%  p1=${(pct(0.01) * 100).toFixed(4)}%  p5=${(pct(0.05) * 100).toFixed(4)}%  p50=${(pct(0.5) * 100).toFixed(4)}%  p95=${(pct(0.95) * 100).toFixed(4)}%  p99=${(pct(0.99) * 100).toFixed(4)}%  max=${(allRates[allRates.length - 1] * 100).toFixed(4)}%`);
  for (const th of THRESHOLDS) {
    console.log(`  |rate| > ${(th * 100).toFixed(2)}% : ${allRates.filter((r) => Math.abs(r) > th).length} events`);
  }
  console.log("");

  console.log("threshold  horizon | train n  trainBps  t    | OOS n  winRate  meanBps  t     CI95");
  console.log("-------------------|------------------------|------------------------------------------");

  for (const th of THRESHOLDS) {
    for (const hz of HORIZONS) {
      const train = [], oos = [];
      for (const s of symbols) {
        const c = klines[s];
        for (const ev of funding[s]) {
          if (ev.settleTime < gmin || ev.settleTime > gmax) continue;
          if (Math.abs(ev.fundingRate) <= th) continue;
          // mean-reversion: high funding = crowded long -> short; low funding = crowded short -> long
          const direction = ev.fundingRate > 0 ? "short" : "long";
          const entryIdx = firstIdxGE(c, ev.settleTime);
          if (entryIdx < 0) continue;
          const r = forwardReturn(c, entryIdx, direction, hz);
          if (r == null) continue;
          if (ev.settleTime < splitSec) train.push(r);
          else oos.push(r);
        }
      }
      const tr = summarize(train), oo = summarize(oos);
      const f1 = (x) => x.toFixed(1);
      console.log(
        `  ${(th * 100).toFixed(2)}%  ${String(hz).padStart(4)}h | ${String(tr.n).padStart(6)}  ${f1(tr.meanBps).padStart(8)}  ${tr.t.toFixed(2).padStart(5)}  | ${String(oo.n).padStart(4)}  ${(oo.winRate * 100).toFixed(1).padStart(5)}%  ${f1(oo.meanBps).padStart(8)}  ${oo.t.toFixed(2).padStart(5)}  [${oo.ciLo.toFixed(1)},${oo.ciHi.toFixed(1)}]`
      );
    }
  }
}

main();

// Standalone funding mean-reversion: does extreme funding predict forward returns?
// Reuses sniper_klines_cache.json (180d, 5m) + funding_cache.json. No re-fetch.
// Run: node funding_validate.mjs
import fs from "fs";

const KLINE_FILE = "sniper_klines_cache.json";
const FUNDING_FILE = "funding_cache.json";
const SPLIT = 0.6;

const THRESHOLDS = [0.0001, 0.0002, 0.0003, 0.0005, 0.0008, 0.0010];
const HORIZONS = [96, 288, 576]; // 8h, 24h, 48h in 5m candles

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
  const symbols = Object.keys(klines).filter((s) => klines[s].length > 0 && funding[s]);

  let gmin = Infinity, gmax = -Infinity;
  for (const s of symbols) {
    const c = klines[s];
    gmin = Math.min(gmin, c[0].time);
    gmax = Math.max(gmax, c[c.length - 1].time);
  }
  const splitSec = gmin + (gmax - gmin) * SPLIT;
  console.log(`Kline span: ${new Date(gmin * 1000).toISOString().slice(0, 10)} -> ${new Date(gmax * 1000).toISOString().slice(0, 10)}`);
  console.log(`Split at: ${new Date(splitSec * 1000).toISOString().slice(0, 10)}\n`);

  // ---- diagnostic: funding rate distribution (within kline window) ----
  const allRates = [];
  for (const s of symbols) {
    for (const ev of funding[s]) {
      const settleSec = Math.floor(ev.settleTime / 1000); // FIX: ms -> s
      if (settleSec < gmin || settleSec > gmax) continue;
      allRates.push(ev.fundingRate);
    }
  }
  allRates.sort((a, b) => a - b);
  const pct = (p) => allRates[Math.floor(allRates.length * p)];
  console.log(`Funding rate distribution (${allRates.length} events in window):`);
  console.log(`  min=${(allRates[0] * 100).toFixed(4)}%  p1=${(pct(0.01) * 100).toFixed(4)}%  p5=${(pct(0.05) * 100).toFixed(4)}%  p50=${(pct(0.5) * 100).toFixed(4)}%  p95=${(pct(0.95) * 100).toFixed(4)}%  p99=${(pct(0.99) * 100).toFixed(4)}%  max=${(allRates[allRates.length - 1] * 100).toFixed(4)}%`);
  for (const th of THRESHOLDS) {
    const n = allRates.filter((r) => Math.abs(r) > th).length;
    console.log(`  |rate| > ${(th * 100).toFixed(2)}% : ${n} events`);
  }
  console.log("");

  // ---- precompute events (units fixed) ----
  const events = {};
  for (const s of symbols) {
    const c = klines[s];
    events[s] = [];
    for (const ev of funding[s]) {
      const settleSec = Math.floor(ev.settleTime / 1000); // FIX: ms -> s
      if (settleSec < gmin || settleSec > gmax) continue;
      const idx = firstIdxGE(c, settleSec);
      if (idx < 0) continue;
      events[s].push({ entryIdx: idx, settleSec, rate: ev.fundingRate });
    }
  }

  console.log("threshold  horizon | train n  trainBps  t    | OOS n  winRate  meanBps  t     CI95");
  console.log("-------------------|------------------------|------------------------------------------");

  for (const th of THRESHOLDS) {
    for (const h of HORIZONS) {
      const trainRs = [], oosRs = [];
      for (const s of symbols) {
        const c = klines[s];
        for (const ev of events[s]) {
          let direction = null;
          if (ev.rate < -th) direction = "long";
          else if (ev.rate > th) direction = "short";
          if (!direction) continue;
          const r = forwardReturn(c, ev.entryIdx, direction, h);
          if (r == null) continue;
          if (ev.settleSec < splitSec) trainRs.push(r);
          else oosRs.push(r);
        }
      }
      const tr = summarize(trainRs);
      const te = summarize(oosRs);
      const hLabel = h === 96 ? "8h" : h === 288 ? "24h" : "48h";
      console.log(
        `${(th * 100).toFixed(2).padStart(7)}%  ${hLabel.padStart(5)} | ` +
        `${String(tr.n).padStart(7)}  ${tr.meanBps.toFixed(1).padStart(8)}  ${tr.t.toFixed(2).padStart(5)}  | ` +
        `${String(te.n).padStart(5)}  ${(te.winRate * 100).toFixed(1).padStart(6)}%  ${te.meanBps.toFixed(1).padStart(7)}  ${te.t.toFixed(2).padStart(5)}  [${te.ciLo.toFixed(1)},${te.ciHi.toFixed(1)}]`
      );
    }
  }
}

main();

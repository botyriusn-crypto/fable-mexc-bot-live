// bybit_funding_regime.mjs — does a regime gate stabilize the funding signal's sign?
// Reuses bybit_klines_cache.json + bybit_funding_cache.json. No re-fetch.
// Run: node bybit_funding_regime.mjs

import fs from "fs";

const KLINE_FILE = "bybit_klines_cache.json";
const FUNDING_FILE = "bybit_funding_cache.json";
const SPLIT = 0.6;

const THRESHOLD = 0.0001; // 0.01% — the large-sample threshold
const HORIZONS = [8, 24, 48]; // 1h candles
const BTC_MA_DAYS = 50;
const MOM_LOOKBACK_SEC = 3 * 86400; // trailing 3 days

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

function lastIdxLE(candles, t) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
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
  const wins = rs.filter((r) => r > 0).length;
  return { n, winRate: n ? wins / n : 0, meanBps: mean, t };
}

// ---- BTC daily closes + 50d MA (no lookahead) ----
function buildBtcMa(btcKlines, days) {
  const daily = [];
  for (const c of btcKlines) {
    const day = Math.floor(c.time / 86400);
    if (daily.length && daily[daily.length - 1].day === day) {
      daily[daily.length - 1].close = c.close;
    } else {
      daily.push({ day, time: c.time, close: c.close });
    }
  }
  const ma = new Array(daily.length).fill(null);
  for (let i = 0; i < daily.length; i++) {
    if (i + 1 >= days) {
      const window = daily.slice(i - days + 1, i + 1).map((d) => d.close);
      ma[i] = avg(window);
    }
  }
  return { daily, ma };
}

function btcRegime(btc, settleTime) {
  const idx = lastIdxLE(btc.daily, settleTime);
  if (idx < 0 || btc.ma[idx] == null) return null;
  return btc.daily[idx].close > btc.ma[idx] ? "bull" : "bear";
}

// ---- funding momentum: current rate vs trailing 3-day mean ----
function buildFundingMomentum(events, lookbackSec) {
  const sorted = [...events].sort((a, b) => a.settleTime - b.settleTime);
  const out = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].settleTime;
    const window = sorted.filter((e) => e.settleTime < t && e.settleTime >= t - lookbackSec);
    if (window.length < 3) { out.set(t, null); continue; }
    const m = avg(window.map((e) => e.fundingRate));
    out.set(t, sorted[i].fundingRate > m ? "rising" : "falling");
  }
  return out;
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

  const btc = buildBtcMa(klines["BTCUSDT"], BTC_MA_DAYS);
  const momentum = {};
  for (const s of symbols) momentum[s] = buildFundingMomentum(funding[s], MOM_LOOKBACK_SEC);

  const events = [];
  for (const s of symbols) {
    const c = klines[s];
    for (const ev of funding[s]) {
      if (ev.settleTime < gmin || ev.settleTime > gmax) continue;
      if (Math.abs(ev.fundingRate) <= THRESHOLD) continue;
      const direction = ev.fundingRate > 0 ? "short" : "long";
      const br = btcRegime(btc, ev.settleTime);
      const mr = momentum[s].get(ev.settleTime);
      events.push({ s, settleTime: ev.settleTime, direction, br, mr });
    }
  }

  console.log(`Threshold ${(THRESHOLD * 100).toFixed(2)}%, ${events.length} events`);
  console.log(`BTC ${BTC_MA_DAYS}d MA: bull=${events.filter((e) => e.br === "bull").length} bear=${events.filter((e) => e.br === "bear").length} null=${events.filter((e) => e.br == null).length}`);
  console.log(`Funding momentum: rising=${events.filter((e) => e.mr === "rising").length} falling=${events.filter((e) => e.mr === "falling").length} null=${events.filter((e) => e.mr == null).length}\n`);

  function returnsFor(subset, horizon) {
    const rs = [];
    for (const e of subset) {
      const c = klines[e.s];
      const entryIdx = firstIdxGE(c, e.settleTime);
      if (entryIdx < 0) continue;
      const r = forwardReturn(c, entryIdx, e.direction, horizon);
      if (r != null) rs.push({ r, settleTime: e.settleTime });
    }
    return rs;
  }

  function report(gateName, getRegime) {
    console.log(`===== GATE: ${gateName} =====`);
    console.log("regime  horizon | train n  trainBps  t    | OOS n  winRate  meanBps  t");
    console.log("----------------|------------------------|-------------------------------");
    for (const regime of ["bull", "bear", "rising", "falling"]) {
      const subset = events.filter((e) => getRegime(e) === regime);
      if (subset.length === 0) continue;
      for (const hz of HORIZONS) {
        const all = returnsFor(subset, hz);
        const train = all.filter((x) => x.settleTime < splitSec).map((x) => x.r);
        const oos = all.filter((x) => x.settleTime >= splitSec).map((x) => x.r);
        const tr = summarize(train), oo = summarize(oos);
        const f1 = (x) => x.toFixed(1);
        console.log(
          ` ${regime.padEnd(6)} ${String(hz).padStart(4)}h | ${String(tr.n).padStart(6)}  ${f1(tr.meanBps).padStart(8)}  ${tr.t.toFixed(2).padStart(5)}  | ${String(oo.n).padStart(4)}  ${(oo.winRate * 100).toFixed(1).padStart(5)}%  ${f1(oo.meanBps).padStart(8)}  ${oo.t.toFixed(2).padStart(5)}`
        );
      }
    }
    console.log("");
  }

  report("BTC 50d MA (bull/bear)", (e) => e.br);
  report("Funding momentum (rising/falling)", (e) => e.mr);
}

main();

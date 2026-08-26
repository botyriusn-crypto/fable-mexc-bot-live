// Sniper parameter sweep — finds whether ANY config has positive expectancy.
// Caches 90d klines to disk, then sweeps the grid in-memory.
// Run: node sweep_sniper.mjs
import fs from "fs";

const BASE = "https://api.mexc.com/api/v1/contract";
const INTERVAL = "Min5";
const TF_SEC = 300;
const DAYS = 90;
const UNIVERSE_SIZE = 30;
const WINDOW = 200;
const MAX_HORIZON = 200;
const CACHE_FILE = "sniper_klines_cache.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- detectSniper, fully parametrized ----
function detectSniper(candles, atr, fundingRate, P) {
  const none = { direction: null, signalType: null, confidence: 0, stopLoss: 0, takeProfit: 0 };
  if (candles.length < 60) return none;
  const SWEEP_LOOKBACK = 20;
  const { sigmaExtreme, volumeSurgeMult, minStopPct, tpSlRatio, stopMode, stopAtrMult } = P;
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

  let direction = null, confidence = 0, extreme = 0, signalType = null;
  if (bullishReclaim) { direction = "long"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; extreme = last.low; signalType = "sweep"; }
  else if (bearishReclaim) { direction = "short"; confidence = 0.6 + Math.min(volSurge, 5) * 0.05; extreme = last.high; signalType = "sweep"; }
  else if (exhaustedDown) { direction = "long"; confidence = sigmaConfidence; extreme = last.low; signalType = "sigma"; }
  else if (exhaustedUp) { direction = "short"; confidence = sigmaConfidence; extreme = last.high; signalType = "sigma"; }

  if (!direction) return none;
  if (direction === "short" && fundingRate > fundingThreshold) confidence += 0.1;
  if (direction === "long" && fundingRate < -fundingThreshold) confidence += 0.1;

  const entry = last.close;
  let structuralStop;
  if (stopMode === "atr") {
    structuralStop = direction === "long" ? entry - atr * stopAtrMult : entry + atr * stopAtrMult;
  } else {
    const atrBuffer = atr * 0.5;
    structuralStop = direction === "long"
      ? Math.min(extreme, last.low) * 0.998
      : Math.max(extreme, last.high) + atrBuffer;
  }
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

// ---- MEXC data (with disk cache) ----
async function fetchKlinesRange(symbol, startSec, endSec) {
  const url = `${BASE}/kline/${symbol}?interval=${INTERVAL}&start=${startSec}&end=${endSec}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kline ${symbol} ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.data) return [];
  const { time, open, high, low, close, vol } = json.data;
  return time.map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] }));
}

async function fetch90Days(symbol) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - DAYS * 86400;
  const CHUNK = 1000 * TF_SEC;
  const out = [];
  let chunkEnd = end;
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
  for (const c of out) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

async function fetchUniverse() {
  const res = await fetch(`${BASE}/ticker`);
  if (!res.ok) throw new Error(`ticker ${res.status}`);
  const json = await res.json();
  const data = json.data.filter((t) => t.symbol.endsWith("_USDT"));
  data.sort((a, b) => Number(b.amount24) - Number(a.amount24));
  return data.slice(0, UNIVERSE_SIZE).map((t) => t.symbol);
}

// ---- metrics ----
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

// ---- main ----
async function main() {
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log(`Loaded ${Object.keys(cache).length} symbols from cache.`);
  }

  const symbols = await fetchUniverse();
  console.log("Universe:", symbols.join(", "));

  for (let si = 0; si < symbols.length; si++) {
    const symbol = symbols[si];
    if (cache[symbol] && cache[symbol].length > 0) continue;
    process.stdout.write(`[${si + 1}/${symbols.length}] ${symbol} fetching... `);
    try {
      const candles = await fetch90Days(symbol);
      cache[symbol] = candles;
      console.log(`${candles.length} candles`);
    } catch (e) { console.log("FAIL", e.message); cache[symbol] = []; }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }

  // Build the grid
  const grid = [];
  for (const stopMode of ["wick", "atr"]) {
    const atrMults = stopMode === "atr" ? [0.5, 1.0, 1.5, 2.0] : [null];
    for (const stopAtrMult of atrMults) {
      for (const tpSlRatio of [1.5, 2.0, 3.0, 4.0]) {
        for (const sigmaExtreme of [2.5, 3.0, 3.5, 4.0]) {
          for (const volumeSurgeMult of [1.5, 2.0, 2.5, 3.0]) {
            for (const minStopPct of [0.004, 0.008, 0.012]) {
              grid.push({ stopMode, stopAtrMult, tpSlRatio, sigmaExtreme, volumeSurgeMult, minStopPct });
            }
          }
        }
      }
    }
  }
  console.log(`\nSweeping ${grid.length} combos over ${symbols.length} symbols...`);

  const results = [];
  for (const P of grid) {
    const trades = [];
    for (const symbol of symbols) {
      const candles = cache[symbol] || [];
      for (let i = WINDOW - 1; i < candles.length; i++) {
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
    }
    const s = summarize(trades);
    results.push({ ...P, ...s });
  }

  results.sort((a, b) => b.expectancy - a.expectancy);

  console.log("\n===== TOP 25 BY EXPECTANCY =====");
  console.log("stopMode stopAtr tpSl sigma volSurge minStop | n  winRate  expR  PF  maxDD");
  for (const r of results.slice(0, 25)) {
    const pf = r.profitFactor === Infinity ? "inf" : r.profitFactor.toFixed(2);
    console.log(
      `${r.stopMode.padEnd(8)} ${String(r.stopAtrMult ?? "-").padEnd(6)} ${String(r.tpSlRatio).padEnd(4)} ${String(r.sigmaExtreme).padEnd(5)} ${String(r.volumeSurgeMult).padEnd(8)} ${String(r.minStopPct).padEnd(7)} | ` +
      `${String(r.n).padStart(4)}  ${(r.winRate * 100).toFixed(1).padStart(5)}%  ${r.expectancy.toFixed(3).padStart(6)}  ${pf.padStart(4)}  ${r.maxDD.toFixed(1)}`
    );
  }

  console.log("\n===== BASELINE (current prod: wick, tpSl=4, sigma=3.5, volSurge=2.0, minStop=0.008) =====");
  const base = results.find((r) => r.stopMode === "wick" && r.tpSlRatio === 4.0 && r.sigmaExtreme === 3.5 && r.volumeSurgeMult === 2.0 && r.minStopPct === 0.008);
  if (base) console.log(`n=${base.n} winRate=${(base.winRate * 100).toFixed(1)}% exp=${base.expectancy.toFixed(3)}R PF=${base.profitFactor.toFixed(2)} maxDD=${base.maxDD.toFixed(1)}R`);

  const positive = results.filter((r) => r.expectancy > 0);
  console.log(`\n${positive.length}/${results.length} combos have positive expectancy.`);
  if (positive.length > 0) {
    console.log("Best positive combo:", JSON.stringify(positive[0]));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

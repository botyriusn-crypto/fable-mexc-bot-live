// BTC long-MA regime gate: does the sniper have an edge ONLY in bull regimes?
// Reuses sniper_klines_cache.json (180d, 5m). No re-fetch.
// Run: node btc_ma_gate_validate.mjs
import fs from "fs";

const CACHE_FILE = "sniper_klines_cache.json";
const WINDOW = 200;
const MAX_HORIZON = 200;
const SPLIT = 0.6;

// BTC gate config
const BTC_SYMBOL = "BTC_USDT";
const GATE_TF_BARS = 48;      // 4H = 48 x 5m
const GATE_MA_PERIOD = 200;   // 200-period MA on 4H (~33 days)

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- higher-timeframe aggregation (identical to regime_filter_validate.mjs) ----
function buildHT(candles, barsPerHT) {
  const out = [];
  for (let i = 0; i < candles.length; i += barsPerHT) {
    const chunk = candles.slice(i, i + barsPerHT);
    if (chunk.length === 0) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ---- BTC regime: bull/bear per 4H bar, mapped to any timestamp (no lookahead) ----
function buildBtcRegime(btcCandles) {
  const ht = buildHT(btcCandles, GATE_TF_BARS);
  const closes = ht.map((b) => b.close);
  const ma = sma(closes, GATE_MA_PERIOD);
  return ht.map((b, i) => ({
    time: b.time,
    regime: ma[i] != null && b.close > ma[i] ? "bull" : "bear",
  }));
}

function regimeAt(bars, t) {
  // last 4H bar strictly before t
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? bars[ans].regime : "bear";
}

// ---- signal (base params locked, identical to regime_filter_validate.mjs) ----
const BASE = { stopAtrMult: 0.5, tpSlRatio: 4, sigmaExtreme: 3.5, volumeSurgeMult: 2, minStopPct: 0.008 };

function detectSniper(candles, atr, fundingRate, P, regime) {
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
  // NOTE: regime filter intentionally inert here (regime="none") — gate applied externally.
  if (regime === "bull" && direction === "short") return none;
  if (regime === "bear" && direction === "long") return none;
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
  const mean = n ? avg(rs) : 0;
  const sd = n > 1 ? Math.sqrt(avg(rs.map((r) => (r - mean) ** 2)) * n / (n - 1)) : 0;
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const t = se > 0 ? mean / se : 0;
  const ciLo = mean - 1.96 * se, ciHi = mean + 1.96 * se;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return { n, wins, winRate: n ? wins / n : 0, expectancy: mean, sd, se, t, ciLo, ciHi, profitFactor, maxDD };
}

function runRange(candles, startIdx, endIdx, P, btcBars) {
  const trades = [];
  for (let i = Math.max(startIdx, WINDOW - 1); i < endIdx; i++) {
    const win = candles.slice(i - WINDOW + 1, i + 1);
    const atr = atr14(candles, i);
    const sig = detectSniper(win, atr, 0, P, "none"); // unfiltered
    if (!sig.direction) continue;
    const res = resolve(candles, i, sig.direction, sig.stopLoss, sig.takeProfit);
    if (res.outcome === "open") continue;
    const risk = Math.abs(candles[i].close - sig.stopLoss);
    const r = risk > 0 ? ((res.exitPrice - candles[i].close) / risk) * (sig.direction === "long" ? 1 : -1) : 0;
    const regime = regimeAt(btcBars, candles[i].time);
    trades.push({ outcome: res.outcome, r, regime });
  }
  return trades;
}

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  const symbols = Object.keys(cache).filter((s) => cache[s].length > 0);
  console.log(`Loaded ${symbols.length} symbols from cache.`);

  if (!cache[BTC_SYMBOL]) {
    console.error(`ERROR: ${BTC_SYMBOL} not in cache — cannot build gate.`);
    process.exit(1);
  }
  const btcBars = buildBtcRegime(cache[BTC_SYMBOL]);
  const gated = btcBars.filter((b) => b.regime === "bull").length;
  console.log(`BTC gate: ${GATE_MA_PERIOD}-period MA on ${GATE_TF_BARS * 5}m bars. ${gated}/${btcBars.length} bars bull (${(100 * gated / btcBars.length).toFixed(1)}%).\n`);

  // global span + split
  let gmin = Infinity, gmax = -Infinity;
  for (const s of symbols) {
    const c = cache[s];
    gmin = Math.min(gmin, c[0].time);
    gmax = Math.max(gmax, c[c.length - 1].time);
  }
  const splitSec = gmin + (gmax - gmin) * SPLIT;
  console.log(`Split at: ${new Date(splitSec * 1000).toISOString().slice(0, 10)}\n`);

  // collect all trades (train + test) with regime tags
  let train = [], oos = [];
  for (const s of symbols) {
    const c = cache[s];
    const si = c.findIndex((x) => x.time >= gmin);
    const ei = c.findIndex((x) => x.time >= splitSec);
    if (si >= 0 && ei >= 0) train = train.concat(runRange(c, si, ei, BASE, btcBars));
    if (ei >= 0) oos = oos.concat(runRange(c, ei, c.length, BASE, btcBars));
  }

  const buckets = [
    { label: "baseline (all)", filter: () => true },
    { label: "bull-gated (BTC>MA)", filter: (t) => t.regime === "bull" },
    { label: "bear-gated (BTC<MA)", filter: (t) => t.regime === "bear" },
  ];

  console.log("bucket             | train n  trainExp  | OOS n  winRate  expR   PF    maxDD  t-stat  CI95");
  console.log("-------------------|---------------------|--------------------------------------------------");

  for (const b of buckets) {
    const tr = summarize(train.filter(b.filter));
    const te = summarize(oos.filter(b.filter));
    const pf = te.profitFactor === Infinity ? "inf" : te.profitFactor.toFixed(2);
    console.log(
      `${b.label.padEnd(19)}| ${String(tr.n).padStart(7)}  ${tr.expectancy.toFixed(2).padStart(8)}  | ` +
      `${String(te.n).padStart(5)}  ${(te.winRate * 100).toFixed(1).padStart(6)}%  ${te.expectancy.toFixed(2).padStart(5)}  ` +
      `${pf.padStart(5)}  ${te.maxDD.toFixed(1).padStart(5)}  ${te.t.toFixed(2).padStart(6)}  [${te.ciLo.toFixed(2)},${te.ciHi.toFixed(2)}]`
    );
  }
}

main();

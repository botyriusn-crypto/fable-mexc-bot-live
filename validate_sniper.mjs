// Single clean train/test split + data diagnostics.
// Run: node validate_sniper.mjs
import fs from "fs";

const CACHE_FILE = "sniper_klines_cache.json";
const WINDOW = 200;
const MAX_HORIZON = 200;
const SPLIT = 0.6; // train on first 60% of the span, test on last 40%

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

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  const symbols = Object.keys(cache).filter((s) => cache[s] && cache[s].length > 0);

  // ---- DIAGNOSTICS ----
  console.log("=== DATA DIAGNOSTICS ===");
  let gmin = Infinity, gmax = -Infinity;
  for (const s of symbols) {
    const c = cache[s];
    const t0 = new Date(c[0].time * 1000).toISOString().slice(0, 10);
    const t1 = new Date(c[c.length - 1].time * 1000).toISOString().slice(0, 10);
    console.log(`${s.padEnd(16)} ${String(c.length).padStart(6)} candles  ${t0} -> ${t1}`);
    gmin = Math.min(gmin, c[0].time);
    gmax = Math.max(gmax, c[c.length - 1].time);
  }
  const totalDays = (gmax - gmin) / 86400;
  console.log(`\nGlobal span: ${totalDays.toFixed(1)} days (${new Date(gmin * 1000).toISOString().slice(0, 10)} -> ${new Date(gmax * 1000).toISOString().slice(0, 10)})`);

  const splitSec = gmin + (gmax - gmin) * SPLIT;
  console.log(`Split at: ${new Date(splitSec * 1000).toISOString().slice(0, 10)} (train before, test after)\n`);

  // ---- GRID (atr/0.5 locked) ----
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

  // ---- SELECT BEST ON TRAIN ----
  let best = null, bestExp = -Infinity;
  for (const P of grid) {
    let all = [];
    for (const symbol of symbols) {
      const c = cache[symbol];
      const si = c.findIndex((x) => x.time >= gmin);
      const ei = c.findIndex((x) => x.time >= splitSec);
      if (si < 0 || ei < 0) continue;
      all = all.concat(runRange(c, si, ei, P));
    }
    const s = summarize(all);
    if (s.n >= 10 && s.expectancy > bestExp) { bestExp = s.expectancy; best = { ...P, train: s }; }
  }

  if (!best) { console.log("No combo met min trades on train. Data too thin."); return; }
  console.log(`Selected on TRAIN: tpSl=${best.tpSlRatio} sigma=${best.sigmaExtreme} volSurge=${best.volumeSurgeMult} minStop=${best.minStopPct}`);
  console.log(`  train: n=${best.train.n} winRate=${(best.train.winRate * 100).toFixed(1)}% exp=${best.train.expectancy.toFixed(3)}R PF=${best.train.profitFactor.toFixed(2)}\n`);

  // ---- TEST ON OOS ----
  let oos = [];
  for (const symbol of symbols) {
    const c = cache[symbol];
    const si = c.findIndex((x) => x.time >= splitSec);
    const ei = c.findIndex((x) => x.time >= gmax);
    if (si < 0) continue;
    oos = oos.concat(runRange(c, si, ei < 0 ? c.length : ei, best));
  }
  const oosS = summarize(oos);
  console.log("===== OUT-OF-SAMPLE (test) =====");
  console.log(`trades=${oosS.n}  wins=${oosS.wins}  winRate=${(oosS.winRate * 100).toFixed(1)}%`);
  console.log(`expectancy=${oosS.expectancy.toFixed(3)}R  profitFactor=${oosS.profitFactor === Infinity ? "inf" : oosS.profitFactor.toFixed(2)}  maxDD=${oosS.maxDD.toFixed(1)}R`);

  console.log("\nVerdict: " + (oosS.expectancy > 0 && oosS.n >= 20
    ? "EDGE CONFIRMED — ship the ATR stop + tuned params."
    : "EDGE NOT ROBUST — likely curve-fit; pivot to a different signal."));
}

main().catch((e) => { console.error(e); process.exit(1); });

// Standalone sniper backtest — A/B: patched (trend gate) vs unpatched.
// Run: node backtest_sniper.mjs
const BASE = "https://api.mexc.com/api/v1/contract";
const INTERVAL = "Min5";
const TF_SEC = 300;
const DAYS = 90;
const UNIVERSE_SIZE = 30;
const WINDOW = 200;      // candles fed to detectSniper
const MAX_HORIZON = 200; // max candles to walk forward for resolution

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- Faithful reimplementation of detectSniper (pure) ----
function detectSniper(candles, atr, fundingRate, patched) {
  const none = { direction: null, signalType: null, confidence: 0, stopLoss: 0, takeProfit: 0, volSurge: 0, z: 0 };
  if (candles.length < 60) return none;
  const SWEEP_LOOKBACK = 20, sigmaExtreme = 3.5, volumeSurgeMult = 2.0;
  const minStopPct = 0.008, tpSlRatio = 4, fundingThreshold = 0.0005;

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

  let bullishReclaim, bearishReclaim;
  if (patched) {
    bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= volumeSurgeMult && (trendUp || trendNeutral);
    bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && prevCandle.close < swingHigh && volSurge >= volumeSurgeMult && (trendDown || trendNeutral);
  } else {
    bullishReclaim = last.low < swingLow && last.close > swingLow && last.close > last.open && volSurge >= volumeSurgeMult;
    bearishReclaim = last.high > swingHigh && last.close < swingHigh && last.close < last.open && prevCandle.close < swingHigh && volSurge >= volumeSurgeMult;
  }

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
  const atrBuffer = atr * 0.5;
  const structuralStop = direction === "long"
    ? Math.min(extreme, last.low) * 0.998
    : Math.max(extreme, last.high) + atrBuffer;
  const structuralRisk = Math.abs(entry - structuralStop) / entry;
  if (structuralRisk < minStopPct) return none;
  const stopLoss = structuralStop;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return none;
  const takeProfit = direction === "long" ? entry + risk * tpSlRatio : entry - risk * tpSlRatio;

  return { direction, signalType, confidence: Math.min(confidence, 0.95), stopLoss, takeProfit, volSurge, z };
}

// 14-period simple ATR (matches runSniperCycle inline calc)
function atr14(candles, i) {
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const c = candles[k], pc = candles[k - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
  }
  return sum / 14;
}

// Forward-walk resolution (matches resolveSniperDecisions)
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

// ---- MEXC data ----
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
function bucket(conf) {
  return conf >= 0.70 ? "high" : conf >= 0.55 ? "mid" : "low";
}
function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "tp");
  const losses = trades.filter((t) => t.outcome === "sl");
  const winRate = n ? wins.length / n : 0;
  const rs = trades.map((t) => t.r);
  const expectancy = n ? avg(rs) : 0;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  // max drawdown in R (chronological)
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return { n, wins: wins.length, losses: losses.length, winRate, expectancy, profitFactor, maxDD };
}
function breakdown(trades) {
  const groups = {};
  for (const t of trades) {
    const k = `${t.signalType}|${t.direction}|${bucket(t.confidence)}`;
    (groups[k] ??= []).push(t);
  }
  return Object.entries(groups)
    .map(([k, v]) => {
      const s = summarize(v);
      return { key: k, n: s.n, winRate: s.winRate, expectancy: s.expectancy };
    })
    .sort((a, b) => b.n - a.n);
}

// ---- main ----
async function main() {
  console.log("Fetching universe (top 30 USDT perps by 24h notional)...");
  const symbols = await fetchUniverse();
  console.log("Universe:", symbols.join(", "));

  const results = { patched: [], unpatched: [] };

  for (let si = 0; si < symbols.length; si++) {
    const symbol = symbols[si];
    process.stdout.write(`[${si + 1}/${symbols.length}] ${symbol} fetching 90d klines... `);
    let candles;
    try { candles = await fetch90Days(symbol); } catch (e) { console.log("FAIL", e.message); continue; }
    console.log(`${candles.length} candles`);

    for (let i = WINDOW - 1; i < candles.length; i++) {
      const win = candles.slice(i - WINDOW + 1, i + 1);
      const atr = atr14(candles, i);
      for (const patched of [false, true]) {
        const sig = detectSniper(win, atr, 0, patched);
        if (!sig.direction) continue;
        const res = resolve(candles, i, sig.direction, sig.stopLoss, sig.takeProfit);
        if (res.outcome === "open") continue;
        const risk = Math.abs(candles[i].close - sig.stopLoss);
        const r = risk > 0 ? ((res.exitPrice - candles[i].close) / risk) * (sig.direction === "long" ? 1 : -1) : 0;
        results[patched ? "patched" : "unpatched"].push({
          symbol, time: candles[i].time, direction: sig.direction,
          signalType: sig.signalType, confidence: sig.confidence,
          outcome: res.outcome, r,
        });
      }
    }
  }

  for (const [label, trades] of Object.entries(results)) {
    const s = summarize(trades);
    console.log(`\n===== ${label.toUpperCase()} =====`);
    console.log(`trades=${s.n}  wins=${s.wins}  losses=${s.losses}`);
    console.log(`winRate=${(s.winRate * 100).toFixed(1)}%  expectancy=${s.expectancy.toFixed(3)}R  profitFactor=${s.profitFactor === Infinity ? "inf" : s.profitFactor.toFixed(2)}  maxDD=${s.maxDD.toFixed(2)}R`);
    console.log("breakdown (type|dir|conf -> n, winRate, expectancyR):");
    for (const b of breakdown(trades)) {
      console.log(`  ${b.key.padEnd(22)} n=${String(b.n).padStart(4)}  wr=${(b.winRate * 100).toFixed(1).padStart(5)}%  exp=${b.expectancy.toFixed(3)}R`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

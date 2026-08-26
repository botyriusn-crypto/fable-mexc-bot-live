// 180-day 5m PERP kline re-fetch (MEXC contract API).
// End-only pagination, walking backward. No lookahead.
// Output: sniper_klines_cache.json  { symbol: [{time,open,high,low,close,volume}] }
// Run: node refetch_180d.mjs
import fs from "fs";

const DAYS = 180;
const INTERVAL = "Min5";
const CACHE_FILE = "sniper_klines_cache.json";
const BASE = "https://contract.mexc.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(600 * (attempt + 1));
    }
  }
}

// non-crypto perps to exclude (stocks, commodities, metals, energy)
const NON_CRYPTO = /STOCK|XAU|SILVER|USOIL|XAUT|GOLD|OIL|COPPER|PLATINUM|PALLADIUM|NICKEL|ZINC|ALUMINUM|LEAD|TIN|CORN|WHEAT|SOYBEAN|SUGAR|COFFEE|COTTON|COCOA|RICE|OAT|LUMBER|CATTLE|HOG|NATURALGAS|GAS|BRENT|WTI/i;

async function topSymbols(n) {
  const j = await getJSON(`${BASE}/api/v1/contract/ticker`);
  const data = j.data || [];
  return data
    .filter((t) => t.symbol && t.symbol.endsWith("_USDT") && !NON_CRYPTO.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, vol: parseFloat(t.amount24 || 0) }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, n)
    .map((t) => t.symbol);
}

// fetch klines ending at endSec (seconds), returns array of candle objects
async function fetchKlines(symbol, endSec) {
  const url = `${BASE}/api/v1/contract/kline/${symbol}?interval=${INTERVAL}&end=${endSec}`;
  const j = await getJSON(url);
  const d = (j && j.data) || {};
  const times = d.time || [];
  return times.map((t, i) => ({
    time: t,
    open: parseFloat(d.open[i]),
    high: parseFloat(d.high[i]),
    low: parseFloat(d.low[i]),
    close: parseFloat(d.close[i]),
    volume: parseFloat(d.vol[i]),
  }));
}

async function fetchSymbol(symbol, startSec) {
  const out = [];
  let endSec = Math.floor(Date.now() / 1000);
  let guard = 0;
  while (guard++ < 100) {
    const batch = await fetchKlines(symbol, endSec);
    if (batch.length === 0) break;
    const oldestHave = out.length ? out[0].time : Infinity;
    const fresh = batch.filter((c) => c.time < oldestHave);
    out.unshift(...fresh);
    const earliest = batch[0].time;
    if (earliest <= startSec) break;
    endSec = earliest - 1;
    await sleep(150);
  }
  return out;
}

async function main() {
  const startSec = Math.floor(Date.now() / 1000) - DAYS * 86400;
  console.log(`Fetching ${DAYS} days of ${INTERVAL} PERP klines (since ${new Date(startSec * 1000).toISOString()})...`);

  const symbols = await topSymbols(30);
  console.log(`Top 30 crypto USDT perps by 24h volume:\n  ${symbols.join(", ")}\n`);

  const cache = {};
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const candles = await fetchSymbol(s, startSec);
    cache[s] = candles;
    const spanDays = candles.length ? ((candles[candles.length - 1].time - candles[0].time) / 86400).toFixed(1) : "0";
    console.log(`[${String(i + 1).padStart(2)}/30] ${s}: ${candles.length} candles, ${spanDays} days`);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const total = Object.values(cache).reduce((a, c) => a + c.length, 0);
  console.log(`\nSaved ${CACHE_FILE}: ${symbols.length} symbols, ${total} total candles.`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

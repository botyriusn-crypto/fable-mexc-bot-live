// fetch_bybit_funding.mjs — fetch Bybit funding history + 1h klines for the
// 24-symbol universe, for funding mean-reversion validation on Bybit.
// Run: node fetch_bybit_funding.mjs

import fs from "fs";

const BASE = "https://api.bybit.com";
const DAYS = 180;
const INTERVAL = "60"; // 1h candles

// MEXC-format symbols -> Bybit (no underscore)
const SYMBOLS = [
  "BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","HYPE_USDT","ZEC_USDT",
  "DOGE_USDT","PEPE_USDT","SUI_USDT","LINK_USDT","TAO_USDT","ENA_USDT",
  "AAVE_USDT","ADA_USDT","WLD_USDT","PUMPFUN_USDT","VELVET_USDT","ONDO_USDT",
  "TRUMPOFFICIAL_USDT","INJ_USDT","PENGU_USDT","AVAX_USDT","TUT_USDT","ZRO_USDT",
].map((s) => s.replace("_", ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`${json.retCode} ${json.retMsg}`);
  return json.result;
}

async function fetchFunding(symbol) {
  const events = [];
  const start = Date.now() - DAYS * 86400 * 1000;
  let endTime = Date.now();
  while (true) {
    const r = await get(`/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200&endTime=${endTime}`);
    const list = r.list || [];
    if (list.length === 0) break;
    for (const e of list) {
      events.push({
        symbol,
        fundingRate: Number(e.fundingRate),
        settleTime: Math.floor(Number(e.fundingRateTimestamp) / 1000), // seconds
      });
    }
    const oldest = Math.min(...list.map((e) => Number(e.fundingRateTimestamp)));
    if (oldest <= start || list.length < 200) break;
    endTime = oldest - 1;
    await sleep(120);
  }
  return events;
}

async function fetchKlines(symbol) {
  const candles = [];
  const start = Date.now() - DAYS * 86400 * 1000;
  let end = Date.now();
  while (true) {
    const r = await get(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${INTERVAL}&limit=1000&end=${end}`);
    const list = r.list || [];
    if (list.length === 0) break;
    for (const c of list) {
      candles.push({
        time: Math.floor(Number(c[0]) / 1000), // seconds
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      });
    }
    const oldest = Math.min(...list.map((c) => Number(c[0])));
    if (oldest <= start || list.length < 1000) break;
    end = oldest - 1;
    await sleep(120);
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

async function main() {
  const fundingCache = {};
  const klineCache = {};
  for (let i = 0; i < SYMBOLS.length; i++) {
    const s = SYMBOLS[i];
    try {
      const f = await fetchFunding(s);
      const k = await fetchKlines(s);
      fundingCache[s] = f;
      klineCache[s] = k;
      console.log(`[${i + 1}/${SYMBOLS.length}] ${s}  funding=${f.length}  klines=${k.length}`);
    } catch (e) {
      console.log(`[${i + 1}/${SYMBOLS.length}] ${s}  SKIPPED (${e.message})`);
    }
    await sleep(150);
  }
  fs.writeFileSync("bybit_funding_cache.json", JSON.stringify(fundingCache));
  fs.writeFileSync("bybit_klines_cache.json", JSON.stringify(klineCache));
  console.log("\nSaved bybit_funding_cache.json + bybit_klines_cache.json");
}

main();

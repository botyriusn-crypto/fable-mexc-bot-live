// Fetch funding-rate history for all cached symbols. No auth required.
// Run: node fetch_funding.mjs
import fs from "fs";

const KLINE_FILE = "sniper_klines_cache.json";
const OUT_FILE = "funding_cache.json";
const BASE = "https://contract.mexc.com/api/v1/contract/funding_rate/history";
const PAGE_SIZE = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFunding(symbol) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${BASE}?symbol=${symbol}&page_num=${page}&page_size=${PAGE_SIZE}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.success || !json.data) {
      console.error(`  ${symbol}: error page ${page}: ${JSON.stringify(json).slice(0, 160)}`);
      break;
    }
    const list = json.data.resultList || [];
    for (const r of list) all.push({ settleTime: r.settleTime, fundingRate: r.fundingRate });
    const totalPage = json.data.totalPage || 1;
    if (page >= totalPage || list.length === 0) break;
    page++;
    await sleep(150); // rate limit 20 req / 2s
  }
  all.sort((a, b) => a.settleTime - b.settleTime);
  return all;
}

async function main() {
  const cache = JSON.parse(fs.readFileSync(KLINE_FILE, "utf8"));
  const symbols = Object.keys(cache).filter((s) => cache[s].length > 0);
  console.log(`Fetching funding history for ${symbols.length} symbols...`);
  const out = {};
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const data = await fetchFunding(s);
    out[s] = data;
    const span = data.length ? `${((data[data.length - 1].settleTime - data[0].settleTime) / 86400000).toFixed(0)}d` : "empty";
    console.log(`[${String(i + 1).padStart(2)}/${symbols.length}] ${s.padEnd(20)} ${String(data.length).padStart(5)} events, ${span}`);
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`\nSaved ${OUT_FILE}.`);
}

main();

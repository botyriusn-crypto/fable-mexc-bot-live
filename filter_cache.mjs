// List all symbols, then drop non-crypto perps (stocks/ETFs/indices/commodities).
import fs from "fs";

const CACHE_FILE = "sniper_klines_cache.json";
const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

// Non-crypto perps on MEXC: equity, leveraged ETFs, indices, commodities.
const NON_CRYPTO = new Set([
  // single stocks
  "TESLA_USDT", "TSLA_USDT", "AAPL_USDT", "AMZN_USDT", "GOOGL_USDT",
  "META_USDT", "MSFT_USDT", "NVDA_USDT", "NFLX_USDT", "AMD_USDT",
  // leveraged ETFs
  "SOXL_USDT", "SOXS_USDT", "KORU_USDT", "TQQQ_USDT", "SQQQ_USDT",
  "SPXL_USDT", "SPXS_USDT", "TNA_USDT", "TZA_USDT", "FNGU_USDT",
  "FNGD_USDT", "LABU_USDT", "LABD_USDT", "YINN_USDT", "YANG_USDT",
  // indices
  "SPX500_USDT", "NAS100_USDT", "US30_USDT", "DJ30_USDT", "GER40_USDT",
  "UK100_USDT", "JPN225_USDT", "HK50_USDT", "AUS200_USDT", "EU50_USDT",
  // commodities / metals / energy
  "XAU_USDT", "XAG_USDT", "XAUT_USDT", "USOIL_USDT", "BRENT_USDT",
  "NATURALGAS_USDT", "COPPER_USDT", "PLATINUM_USDT", "PALLADIUM_USDT",
]);

console.log("=== ALL SYMBOLS ===");
for (const [s, c] of Object.entries(cache)) {
  const flag = NON_CRYPTO.has(s) ? "  <-- NON-CRYPTO (drop)" : "";
  console.log(`${s.padEnd(20)} ${String(c.length).padStart(7)} candles${flag}`);
}

const kept = {};
let dropped = 0;
for (const [s, c] of Object.entries(cache)) {
  if (NON_CRYPTO.has(s)) { dropped++; continue; }
  kept[s] = c;
}

fs.writeFileSync(CACHE_FILE, JSON.stringify(kept));
console.log(`\nDropped ${dropped} non-crypto symbol(s). Kept ${Object.keys(kept).length} crypto perps.`);

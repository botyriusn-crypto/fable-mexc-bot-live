export interface MexcSymbolSpec {
  priceScale: number
  priceUnit: number
  contractSize: number
  minVol: number
  maxVol: number
  makerFeeRate: number
  takerFeeRate: number
}

// Cache for dynamically fetched specs. This is the source of truth once
// warmed -- live data from MEXC always wins over the hardcoded fallback
// table below.
const specCache: Record<string, MexcSymbolSpec> = {};
let lastFetchTime = 0;
const CACHE_TTL = 300000; // 5 minutes

// Last-resort fallback specs, used ONLY when a live fetch has failed or a
// symbol is not present in MEXC contract-detail response (e.g. during an
// API outage). NOT authoritative -- a wrong value here (AKE_USDT was
// previously hardcoded with contractSize=1 when MEXC real value is 1000,
// which caused silent 1000x margin/order-size miscalculation) can be very
// costly, so getMexcSpecAsync/getMexcSpec always prefer live data and
// only fall back to this table when live data genuinely is not available.
const KNOWN_SPECS: Record<string, MexcSymbolSpec> = {
  BTC_USDT:   { priceScale: 1, priceUnit: 0.1,      contractSize: 0.0001, minVol: 1, maxVol: 400000, makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  ETH_USDT:   { priceScale: 2, priceUnit: 0.01,     contractSize: 0.01,   minVol: 1, maxVol: 70000,   makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  BEAT_USDT:  { priceScale: 3, priceUnit: 0.001,    contractSize: 1,      minVol: 1, maxVol: 34100,   makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  APR_USDT:   { priceScale: 4, priceUnit: 0.0001,   contractSize: 1,      minVol: 1, maxVol: Number.MAX_SAFE_INTEGER, makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  AKE_USDT:   { priceScale: 6, priceUnit: 0.000001, contractSize: 1000,   minVol: 1, maxVol: 2000,     makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  PROM_USDT:  { priceScale: 4, priceUnit: 0.0001,   contractSize: 1,      minVol: 1, maxVol: Number.MAX_SAFE_INTEGER, makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
  VELVET_USDT:{ priceScale: 4, priceUnit: 0.0001,   contractSize: 1,      minVol: 1, maxVol: Number.MAX_SAFE_INTEGER, makerFeeRate: 0.0000, takerFeeRate: 0.0002 },
};

async function fetchMexcSpecs(): Promise<Record<string, MexcSymbolSpec>> {
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL && Object.keys(specCache).length > 0) {
    return specCache;
  }

  try {
    const response = await fetch('https://contract.mexc.com/api/v1/contract/detail');
    const data = await response.json();

    if (data?.data && Array.isArray(data.data)) {
      for (const symbol of data.data) {
        if (symbol.symbol && symbol.priceScale && symbol.contractSize) {
          specCache[symbol.symbol] = {
            priceScale: symbol.priceScale,
            priceUnit: symbol.priceUnit || Math.pow(10, -symbol.priceScale),
            contractSize: symbol.contractSize,
            minVol: symbol.minVol || 1,
            maxVol: symbol.maxVol || Number.MAX_SAFE_INTEGER,
            // Real per-symbol fee rates. MEXC runs zero-fee promos on
            // some symbols (isZeroFeeSymbol / mc-trade-zone-0fees) -- do
            // NOT assume a flat fee across all pairs, use what the API
            // actually reports for each one.
            makerFeeRate: typeof symbol.makerFeeRate === "number" ? symbol.makerFeeRate : 0,
            takerFeeRate: typeof symbol.takerFeeRate === "number" ? symbol.takerFeeRate : 0.0002,
          };
        }
      }
      lastFetchTime = now;
      console.log(`[Precision] Fetched specs for ${Object.keys(specCache).length} symbols from MEXC`);
    }
  } catch (err) {
    console.error('[Precision] Failed to fetch MEXC specs:', err instanceof Error ? err.message : String(err));
  }

  return specCache;
}

// Warm the cache as soon as this module loads, so the SYNCHRONOUS
// getMexcSpec() (used inside order-rounding code that cannot await a
// fetch) has real, live data available as early as possible -- instead
// of silently relying on KNOWN_SPECS until some other code path happens
// to trigger a fetch first.
fetchMexcSpecs().catch((err) => {
  console.error('[Precision] Startup spec warmup failed:', err instanceof Error ? err.message : String(err));
});

export async function getMexcSpecAsync(symbol: string, price: number): Promise<MexcSymbolSpec> {
  // Cache first -- populated by the startup warmup above or a previous
  // live fetch in this process.
  if (specCache[symbol]) {
    return specCache[symbol];
  }

  // Always try a live fetch before falling back to hardcoded data. This
  // is the fix for symbols whose KNOWN_SPECS entry is wrong: previously,
  // a hardcoded entry short-circuited this function and permanently
  // blocked the real value from ever being fetched, even though the
  // live-fetch code already existed. Live data always wins now when
  // it is available.
  const specs = await fetchMexcSpecs();
  if (specs[symbol]) {
    return specs[symbol];
  }

  // Fallback for when the live fetch failed or did not include this symbol.
  if (KNOWN_SPECS[symbol]) {
    console.warn(`[Precision] Using hardcoded fallback spec for ${symbol} -- live MEXC data unavailable`);
    return KNOWN_SPECS[symbol];
  }

  // Last-resort generic fallback for a genuinely unknown symbol.
  const fallbackScale = price < 1 ? 4 : 2;
  console.warn(`[Precision] No spec found for ${symbol} in live data or KNOWN_SPECS -- using generic fallback, order sizing may be inaccurate`);
  return {
    priceScale: fallbackScale,
    priceUnit: Math.pow(10, -fallbackScale),
    contractSize: 1,
    minVol: 1,
    maxVol: Number.MAX_SAFE_INTEGER,
    makerFeeRate: 0.0000,
    takerFeeRate: 0.0002,
  };
}

export function getMexcSpec(symbol: string, price: number): MexcSymbolSpec {
  // Synchronous version -- relies on the cache already being warm (via
  // the module-load warmup above, or a prior getMexcSpecAsync call
  // earlier in this same request/tick). Falls back to hardcoded/generic
  // data only if the cache genuinely has not been populated yet (e.g.
  // the very first request right after a cold start, before the startup
  // fetch has resolved).
  if (specCache[symbol]) {
    return specCache[symbol];
  }
  if (KNOWN_SPECS[symbol]) {
    console.warn(`[Precision] getMexcSpec: cache not yet warm for ${symbol}, using hardcoded fallback`);
    return KNOWN_SPECS[symbol];
  }

  const fallbackScale = price < 1 ? 4 : 2;
  console.warn(`[Precision] getMexcSpec: no spec for ${symbol} in cache or KNOWN_SPECS -- using generic fallback, order sizing may be inaccurate`);
  return {
    priceScale: fallbackScale,
    priceUnit: Math.pow(10, -fallbackScale),
    contractSize: 1,
    minVol: 1,
    maxVol: Number.MAX_SAFE_INTEGER,
    makerFeeRate: 0.0000,
    takerFeeRate: 0.0002,
  };
}

export function roundMexcQuantity(symbol: string, price: number, coinQuantity: number): number {
  const spec = getMexcSpec(symbol, price);
  let vol = Math.round(coinQuantity / spec.contractSize);
  if (!Number.isFinite(vol) || vol < spec.minVol) vol = spec.minVol;
  if (vol > spec.maxVol) vol = spec.maxVol;
  return vol;
}

export function roundMexcPrice(symbol: string, price: number): number {
  const spec = getMexcSpec(symbol, price);
  const snapped = Math.round(price / spec.priceUnit) * spec.priceUnit;
  return Number(snapped.toFixed(spec.priceScale));
}

// Real per-symbol fee rates, for use in PnL calculations. Prefer this
// over the flat TAKER_FEE/MAKER_FEE constants in grid.ts wherever
// possible -- MEXC fee rates vary per symbol (some run at 0% under
// promos, most do not), and a flat guessed constant can silently make
// every PnL figure wrong in the same direction.
export function getMexcFeeRates(symbol: string): { makerFeeRate: number; takerFeeRate: number } {
  const spec = getMexcSpec(symbol, 1);
  return { makerFeeRate: spec.makerFeeRate, takerFeeRate: spec.takerFeeRate };
}

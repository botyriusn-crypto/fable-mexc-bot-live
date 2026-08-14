export interface MexcSymbolSpec {
  priceScale: number
  priceUnit: number
  contractSize: number
  minVol: number
  maxVol: number
}

// Cache for dynamically fetched specs
const specCache: Record<string, MexcSymbolSpec> = {};
let lastFetchTime = 0;
const CACHE_TTL = 300000; // 5 minutes

// Known fallback specs for common symbols
const KNOWN_SPECS: Record<string, MexcSymbolSpec> = {
  BTC_USDT:   { priceScale: 1, priceUnit: 0.1,     contractSize: 0.0001, minVol: 1, maxVol: 400000 },
  ETH_USDT:   { priceScale: 2, priceUnit: 0.01,    contractSize: 0.01,   minVol: 1, maxVol: 70000 },
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

export async function getMexcSpecAsync(symbol: string, price: number): Promise<MexcSymbolSpec> {
  // Try cache first
  if (specCache[symbol]) {
    return specCache[symbol];
  }

  // Try known specs
  if (KNOWN_SPECS[symbol]) {
    return KNOWN_SPECS[symbol];
  }

  // Fetch from MEXC
  const specs = await fetchMexcSpecs();
  if (specs[symbol]) {
    return specs[symbol];
  }

  // Fallback for unknown symbols
  const fallbackScale = price < 1 ? 4 : 2;
  return {
    priceScale: fallbackScale,
    priceUnit: Math.pow(10, -fallbackScale),
    contractSize: 1,
    minVol: 1,
    maxVol: Number.MAX_SAFE_INTEGER,
  };
}

export function getMexcSpec(symbol: string, price: number): MexcSymbolSpec {
  // Synchronous version - use cached or fallback
  if (specCache[symbol]) {
    return specCache[symbol];
  }
  if (KNOWN_SPECS[symbol]) {
    return KNOWN_SPECS[symbol];
  }

  // Fallback
  const fallbackScale = price < 1 ? 4 : 2;
  return {
    priceScale: fallbackScale,
    priceUnit: Math.pow(10, -fallbackScale),
    contractSize: 1,
    minVol: 1,
    maxVol: Number.MAX_SAFE_INTEGER,
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

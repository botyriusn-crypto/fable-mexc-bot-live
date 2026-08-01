export interface MexcSymbolSpec {
  priceScale: number
  priceUnit: number
  contractSize: number
  minVol: number
  maxVol: number
}

const SPECS: Record<string, MexcSymbolSpec> = {
  BTC_USDT:   { priceScale: 1, priceUnit: 0.1,     contractSize: 0.0001, minVol: 1, maxVol: 400000 },
  ETH_USDT:   { priceScale: 2, priceUnit: 0.01,    contractSize: 0.01,   minVol: 1, maxVol: 70000 },
  ADA_USDT:   { priceScale: 4, priceUnit: 0.0001,  contractSize: 1,      minVol: 1, maxVol: 11000000 },
  BANK_USDT:  { priceScale: 5, priceUnit: 0.00001, contractSize: 100,    minVol: 1, maxVol: 2000 },
  RIVER_USDT: { priceScale: 3, priceUnit: 0.001,   contractSize: 0.1,    minVol: 1, maxVol: 91500 },
}

export function getMexcSpec(symbol: string, price: number): MexcSymbolSpec {
  const fallbackScale = price < 1 ? 4 : 2
  return (
    SPECS[symbol] ?? {
      priceScale: fallbackScale,
      priceUnit: Math.pow(10, -fallbackScale),
      contractSize: 1,
      minVol: 1,
      maxVol: Number.MAX_SAFE_INTEGER,
    }
  )
}

export function roundMexcQuantity(symbol: string, price: number, coinQuantity: number): number {
  const spec = getMexcSpec(symbol, price)
  let vol = Math.round(coinQuantity / spec.contractSize)
  if (!Number.isFinite(vol) || vol < spec.minVol) vol = spec.minVol
  if (vol > spec.maxVol) vol = spec.maxVol
  return vol
}

export function roundMexcPrice(symbol: string, price: number): number {
  const spec = getMexcSpec(symbol, price)
  const snapped = Math.round(price / spec.priceUnit) * spec.priceUnit
  return Number(snapped.toFixed(spec.priceScale))
}

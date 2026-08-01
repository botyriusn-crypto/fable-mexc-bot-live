// Test BANK grid with proper minimum spacing
const TAKER_FEE = 0.0002
const PRICE = 0.36
const LEVELS = 5
const PER_LEVEL = 500
const LEV = 2

// Current broken calculation
const brokenBreakeven = PRICE * 2 * TAKER_FEE
const brokenMin = brokenBreakeven * 3
console.log(`Current (broken): breakeven=${brokenBreakeven.toFixed(6)} min=${brokenMin.toFixed(6)}`)

// Fixed: use percentage-based minimum spacing
const MIN_SPACING_PCT = 0.5 // minimum 0.5% spacing
const minSpacingFixed = PRICE * MIN_SPACING_PCT / 100
console.log(`Fixed: min spacing = ${minSpacingFixed.toFixed(4)} (${MIN_SPACING_PCT}%)`)

// Simulate grid with fixed spacing
interface Trade { buyPrice: number; sellPrice: number; pnl: number }
const trades: Trade[] = []
let gBuys: Array<{price: number; qty: number}> = []
let gSells: Array<{price: number; qty: number; buyPrice: number}> = []
let equity = 10000

const spacing = minSpacingFixed
const buyLevels = Math.floor(LEVELS / 2)

// Place initial ladder
for (let i = 1; i <= buyLevels; i++) {
  const bp = PRICE - spacing * i
  if (bp <= 0) continue
  gBuys.push({ price: bp, qty: (PER_LEVEL * LEV) / bp })
}
console.log(`Placed ${gBuys.length} buys from ${gBuys[gBuys.length-1]?.price.toFixed(4)} to ${gBuys[0]?.price.toFixed(4)}`)
console.log(`Sell targets: ${gBuys.map(b => (b.price + spacing).toFixed(4)).join(', ')}`)
console.log(`\nEach cycle profit: ${(spacing/PRICE*100).toFixed(2)}% = $${(PER_LEVEL * LEV * spacing/PRICE - PER_LEVEL * LEV * PRICE * 2 * TAKER_FEE / PRICE).toFixed(2)}/trade`)

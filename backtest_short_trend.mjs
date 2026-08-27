import pg from "pg"

const BASE = "https://api.mexc.com/api/v1/contract"
const INTERVAL = "Min5"
const SECONDS = 300
const LIMIT = 200

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

// Clean shorts only: rows with stopLoss/takeProfit stored (R-multiples are valid).
const { rows } = await client.query(`
  SELECT symbol, candidate_direction, outcome_return, lorentzian_filters
  FROM classifier_decisions
  WHERE strategy = 'sniper'
    AND candidate_direction = 'short'
    AND resolved_at IS NOT NULL
    AND outcome_return IS NOT NULL
  ORDER BY created_at ASC
`)

const shorts = rows
  .map(r => {
    const f = (typeof r.lorentzian_filters === "string" ? JSON.parse(r.lorentzian_filters) : r.lorentzian_filters) ?? {}
    return { symbol: r.symbol, r: Number(r.outcome_return), entryTime: f.entryTime, hasLevels: f.stopLoss != null && f.takeProfit != null }
  })
  .filter(s => s.hasLevels && s.entryTime != null)

console.log(`Clean shorts with entryTime: ${shorts.length}\n`)

// Replicate detectSniper's trend logic exactly.
function trendState(closes) {
  const window = closes.slice(-100)
  const older = closes.slice(0, Math.max(0, closes.length - 100))
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
  const mean = avg(window)
  const olderMean = older.length > 0 ? avg(older) : mean
  const trendUp = mean > olderMean
  const trendDown = mean < olderMean
  const trendNeutral = Math.abs(mean - olderMean) / olderMean < 0.05
  return { trendUp, trendDown, trendNeutral, mean, olderMean }
}

async function fetchKlines(symbol, entryTime) {
  const end = entryTime + SECONDS
  const start = entryTime - SECONDS * LIMIT
  const url = `${BASE}/kline/${symbol}?interval=${INTERVAL}&start=${start}&end=${end}`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json.success || !json.data) throw new Error("no data")
  const { time, close } = json.data
  return time.map((t, i) => ({ time: t, close: close[i] })).sort((a, b) => a.time - b.time)
}

const results = []
let skipped = 0
for (let i = 0; i < shorts.length; i++) {
  const s = shorts[i]
  try {
    const candles = await fetchKlines(s.symbol, s.entryTime)
    // Take the entry candle (time <= entryTime) and the 199 before it.
    let idx = candles.findIndex(c => c.time === s.entryTime)
    if (idx < 0) idx = candles.findIndex(c => c.time > s.entryTime) - 1
    if (idx < 0) idx = candles.length - 1
    const slice = candles.slice(Math.max(0, idx - (LIMIT - 1)), idx + 1)
    if (slice.length < 60) { skipped++; continue }
    const closes = slice.map(c => c.close)
    const t = trendState(closes)
    // New filter: strict downtrend only. Blocked = neutral-up or flat or uptrend.
    const passes = t.trendDown
    results.push({ ...s, passes, trendUp: t.trendUp, trendDown: t.trendDown, trendNeutral: t.trendNeutral })
  } catch (e) {
    skipped++
  }
  if ((i + 1) % 25 === 0) console.log(`  ...processed ${i + 1}/${shorts.length}`)
  await new Promise(r => setTimeout(r, 120)) // gentle rate limit
}

console.log(`\nProcessed ${results.length}, skipped ${skipped} (delisted/no data)\n`)

function stats(list) {
  const n = list.length
  if (n === 0) return { n: 0, totalR: 0, winRate: 0, avgR: 0 }
  const totalR = list.reduce((s, x) => s + x.r, 0)
  const wins = list.filter(x => x.r > 0).length
  return { n, totalR, winRate: wins / n, avgR: totalR / n }
}

const passes = results.filter(x => x.passes)
const blocked = results.filter(x => !x.passes)

// Breakdown of the blocked group by actual trend state
const blockedUp = blocked.filter(x => x.trendUp && !x.trendNeutral)
const blockedNeutralUp = blocked.filter(x => x.trendNeutral && x.trendUp)
const blockedNeutralDown = blocked.filter(x => x.trendNeutral && x.trendDown)
const blockedFlat = blocked.filter(x => !x.trendUp && !x.trendDown)

function row(name, s) {
  return { name, trades: s.n, totalR: s.totalR.toFixed(2), winRate: (s.winRate * 100).toFixed(1) + "%", avgR: s.avgR.toFixed(3) }
}

console.log("=== SHORT: new strict-downtrend filter ===")
console.table([
  row("PASSES (trendDown)", stats(passes)),
  row("BLOCKED (neutral/up)", stats(blocked)),
])

console.log("\n=== BLOCKED group, by actual trend state ===")
console.table([
  row("  uptrend (trendUp, not neutral)", stats(blockedUp)),
  row("  neutral-up (within 5%, mean>older)", stats(blockedNeutralUp)),
  row("  neutral-down (within 5%, mean<older)", stats(blockedNeutralDown)),
  row("  flat (mean==older)", stats(blockedFlat)),
])

console.log("\n=== What the fix would have done ===")
const before = stats(results)
const after = stats(passes)
console.log(`  Before: ${before.n} shorts, totalR ${before.totalR.toFixed(2)}, winRate ${(before.winRate*100).toFixed(1)}%`)
console.log(`  After:  ${after.n} shorts, totalR ${after.totalR.toFixed(2)}, winRate ${(after.winRate*100).toFixed(1)}%`)
console.log(`  Removed ${blocked.length} shorts that bled ${stats(blocked).totalR.toFixed(2)}R`)

await client.end()

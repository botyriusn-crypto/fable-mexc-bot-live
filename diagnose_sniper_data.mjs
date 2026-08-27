import pg from "pg"

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

// Pull everything, including the stored stop/take to classify legacy vs new.
const { rows } = await client.query(`
  SELECT symbol, candidate_direction, outcome_return, created_at, resolved_at,
         lorentzian_filters
  FROM classifier_decisions
  WHERE strategy = 'sniper' AND resolved_at IS NOT NULL AND outcome_return IS NOT NULL
  ORDER BY created_at ASC
`)

const legacy = []   // no stopLoss/takeProfit stored -> outcome_return is a PERCENT
const clean = []    // has stopLoss/takeProfit -> outcome_return is an R-multiple
for (const r of rows) {
  const f = r.lorentzian_filters ?? {}
  if (f.stopLoss == null || f.takeProfit == null) legacy.push(r)
  else clean.push(r)
}

console.log(`Total resolved: ${rows.length}`)
console.log(`  Legacy (percent-return): ${legacy.length}`)
console.log(`  Clean  (R-multiple):     ${clean.length}\n`)

function stats(list, unit) {
  const n = list.length
  if (n === 0) return null
  const vals = list.map(r => Number(r.outcome_return))
  const total = vals.reduce((s, v) => s + v, 0)
  const wins = vals.filter(v => v > 0).length
  const losses = vals.filter(v => v < 0).length
  const flat = vals.filter(v => v === 0).length
  const sorted = [...vals].sort((a, b) => a - b)
  const min = sorted[0], max = sorted[sorted.length - 1]
  const p50 = sorted[Math.floor(n * 0.5)]
  const p90 = sorted[Math.floor(n * 0.9)]
  return { unit, n, total: total.toFixed(2), avg: (total / n).toFixed(3), winRate: (wins / n * 100).toFixed(1) + "%", wins, losses, flat, min: min.toFixed(2), max: max.toFixed(2), p50: p50.toFixed(2), p90: p90.toFixed(2) }
}

console.log("=== LEGACY (percent returns) ===")
console.table([stats(legacy, "%")])

console.log("\n=== CLEAN (R-multiples) ===")
console.table([stats(clean, "R")])

// For clean rows, break down by direction and signal type
function byKey(list, keyFn) {
  const m = new Map()
  for (const r of list) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

console.log("\n=== CLEAN by direction ===")
for (const [dir, list] of byKey(clean, r => r.candidate_direction)) {
  const s = stats(list, "R")
  console.log(`  ${dir}: n=${s.n} totalR=${s.total} avgR=${s.avg} winRate=${s.winRate}`)
}

console.log("\n=== CLEAN by signal type ===")
for (const [type, list] of byKey(clean, r => (r.lorentzian_filters ?? {}).signalType ?? "unknown")) {
  const s = stats(list, "R")
  console.log(`  ${type}: n=${s.n} totalR=${s.total} avgR=${s.avg} winRate=${s.winRate}`)
}

// Histogram of clean R-multiples (should cluster at -1 and +4 if clean)
console.log("\n=== CLEAN R-multiple histogram ===")
const buckets = {}
for (const r of clean) {
  const v = Number(r.outcome_return)
  const b = v <= -3 ? "<=-3" : v <= -1.5 ? "-3..-1.5" : v <= -0.5 ? "-1.5..-0.5" : v < 0 ? "-0.5..0" : v === 0 ? "0" : v < 0.5 ? "0..0.5" : v < 1.5 ? "0.5..1.5" : v < 3 ? "1.5..3" : v < 4.5 ? "3..4.5" : ">4.5"
  buckets[b] = (buckets[b] || 0) + 1
}
for (const [b, c] of Object.entries(buckets)) console.log(`  ${b.padEnd(12)} ${c}`)

await client.end()

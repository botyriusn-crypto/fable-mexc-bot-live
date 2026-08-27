import pg from "pg"

const BASE = "https://api.mexc.com/api/v1/contract"
const INTERVAL = "Min5"
const SECONDS = 300
const LIMIT = 200

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query(`
  SELECT symbol, candidate_direction, outcome_return, entry_price, lorentzian_filters
  FROM classifier_decisions
  WHERE strategy = 'sniper'
    AND candidate_direction = 'long'
    AND resolved_at IS NOT NULL
    AND outcome_return IS NOT NULL
  ORDER BY created_at ASC
`)

const longs = rows
  .map(r => {
    const f = (typeof r.lorentzian_filters === "string" ? JSON.parse(r.lorentzian_filters) : r.lorentzian_filters) ?? {}
    return {
      symbol: r.symbol,
      entry: Number(r.entry_price),
      stopLoss: f.stopLoss != null ? Number(f.stopLoss) : null,
      entryTime: f.entryTime,
    }
  })
  .filter(s => s.stopLoss != null && s.entryTime != null && s.entry > s.stopLoss)

console.log(`Clean longs with structural stop + entryTime: ${longs.length}\n`)

async function fetchKlines(symbol, entryTime) {
  const end = entryTime + SECONDS
  const start = entryTime - SECONDS * LIMIT
  const url = `${BASE}/kline/${symbol}?interval=${INTERVAL}&start=${start}&end=${end}`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json.success || !json.data) throw new Error("no data")
  const { time, high, low } = json.data
  return time.map((t, i) => ({ time: t, high: high[i], low: low[i] })).sort((a, b) => a.time - b.time)
}

const prepped = []
let skipped = 0
for (let i = 0; i < longs.length; i++) {
  const s = longs[i]
  try {
    const candles = await fetchKlines(s.symbol, s.entryTime)
    let idx = candles.findIndex(c => c.time === s.entryTime)
    if (idx < 0) idx = candles.findIndex(c => c.time > s.entryTime) - 1
    if (idx < 0) idx = candles.length - 1
    const forward = candles.slice(idx + 1)
    prepped.push({ ...s, forward })
  } catch (e) { skipped++ }
  if ((i + 1) % 25 === 0) console.log(`  ...fetched ${i + 1}/${longs.length}`)
  await new Promise(r => setTimeout(r, 120))
}

console.log(`\nPrepped ${prepped.length} longs, skipped ${skipped}\n`)

// Fix the STRUCTURAL stop (stored), vary only the TP (R:R)
const tpSlRatios = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

console.log("R:R | n | winRate | breakEven | totalR | avgR | stopPct")
console.log("----|---|---------|-----------|--------|------|--------")

for (const rr of tpSlRatios) {
  let totalR = 0, wins = 0, n = 0, open = 0
  let stopPctSum = 0
  for (const p of prepped) {
    const risk = p.entry - p.stopLoss
    if (risk <= 0) continue
    const tp = p.entry + risk * rr
    stopPctSum += (risk / p.entry) * 100
    let outcome = "open"
    for (const c of p.forward) {
      if (c.low <= p.stopLoss) { outcome = "sl"; break }
      if (c.high >= tp) { outcome = "tp"; break }
    }
    if (outcome === "open") { open++; continue }
    n++
    if (outcome === "tp") { wins++; totalR += rr }
    else totalR -= 1
  }
  const winRate = n ? wins / n : 0
  const breakEven = 1 / (1 + rr)
  const avgR = n ? totalR / n : 0
  const stopPct = n ? (stopPctSum / prepped.length).toFixed(2) : "0"
  const flag = winRate > breakEven ? "  <-- PROFITABLE" : ""
  console.log(
    `${rr.toString().padStart(3)} | ${n.toString().padStart(3)} | ${(winRate*100).toFixed(1).padStart(7)}% | ${(breakEven*100).toFixed(1).padStart(9)}% | ${totalR.toFixed(1).padStart(6)} | ${avgR.toFixed(3).padStart(4)} | ${stopPct}%${flag}`
  )
}

await client.end()

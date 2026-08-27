import pg from "pg"

const BASE = "https://api.mexc.com/api/v1/contract"
const INTERVAL = "Min5"
const SECONDS = 300
const LIMIT = 200

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

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
    return { symbol: r.symbol, entryTime: f.entryTime, hasLevels: f.stopLoss != null && f.takeProfit != null }
  })
  .filter(s => s.hasLevels && s.entryTime != null)

console.log(`Clean shorts with entryTime: ${shorts.length}\n`)

async function fetchKlines(symbol, entryTime) {
  const end = entryTime + SECONDS
  const start = entryTime - SECONDS * LIMIT
  const url = `${BASE}/kline/${symbol}?interval=${INTERVAL}&start=${start}&end=${end}`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json.success || !json.data) throw new Error("no data")
  const { time, open, high, low, close } = json.data
  return time.map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i] })).sort((a, b) => a.time - b.time)
}

// ATR at index idx (14-period, matching production: last 14 candles incl. entry)
function atrAt(candles, idx, period = 14) {
  let sum = 0
  for (let i = idx - period + 1; i <= idx; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  return sum / period
}

// Fetch + prep each short once (entry close, ATR, forward candles)
const prepped = []
let skipped = 0
for (let i = 0; i < shorts.length; i++) {
  const s = shorts[i]
  try {
    const candles = await fetchKlines(s.symbol, s.entryTime)
    let idx = candles.findIndex(c => c.time === s.entryTime)
    if (idx < 0) idx = candles.findIndex(c => c.time > s.entryTime) - 1
    if (idx < 0) idx = candles.length - 1
    if (idx < 14) { skipped++; continue }
    const entry = candles[idx].close
    const a = atrAt(candles, idx)
    const forward = candles.slice(idx + 1)
    prepped.push({ symbol: s.symbol, entry, atr: a, forward })
  } catch (e) { skipped++ }
  if ((i + 1) % 25 === 0) console.log(`  ...fetched ${i + 1}/${shorts.length}`)
  await new Promise(r => setTimeout(r, 120))
}

console.log(`\nPrepped ${prepped.length} shorts, skipped ${skipped}\n`)

// Sweep grid
const stopAtrMults = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0]
const tpSlRatios = [1, 1.5, 2, 3, 4]

console.log("stopATR | R:R | n | winRate | breakEven | totalR | avgR | stopPct")
console.log("--------|-----|---|---------|-----------|--------|------|--------")

for (const sm of stopAtrMults) {
  for (const rr of tpSlRatios) {
    let totalR = 0, wins = 0, n = 0, open = 0
    let stopPctSum = 0
    for (const p of prepped) {
      const stop = p.entry + sm * p.atr
      const risk = stop - p.entry
      if (risk <= 0) continue
      const tp = p.entry - risk * rr
      stopPctSum += (risk / p.entry) * 100
      let outcome = "open"
      for (const c of p.forward) {
        if (c.high >= stop) { outcome = "sl"; break }
        if (c.low <= tp) { outcome = "tp"; break }
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
      `${sm.toFixed(1).padStart(7)} | ${rr.toString().padStart(3)} | ${n.toString().padStart(3)} | ${(winRate*100).toFixed(1).padStart(7)}% | ${(breakEven*100).toFixed(1).padStart(9)}% | ${totalR.toFixed(1).padStart(6)} | ${avgR.toFixed(3).padStart(4)} | ${stopPct}%${flag}`
    )
  }
  console.log("--------|-----|---|---------|-----------|--------|------|--------")
}

await client.end()

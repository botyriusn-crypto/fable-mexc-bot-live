import pg from "pg"

const WINDOW_MS = 6 * 60 * 60 * 1000     // rolling-R gate window (tune this)
const KILL_MS = 24 * 60 * 60 * 1000      // kill-switch meta window

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query(`
  SELECT symbol, candidate_direction, outcome_return, created_at, resolved_at
  FROM classifier_decisions
  WHERE strategy = 'sniper' AND resolved_at IS NOT NULL AND outcome_return IS NOT NULL
  ORDER BY created_at ASC
`)

const trades = rows.map(r => ({
  symbol: r.symbol,
  dir: r.candidate_direction,
  r: Number(r.outcome_return),
  entry: new Date(r.created_at).getTime(),
  resolved: new Date(r.resolved_at).getTime(),
}))

console.log(`Loaded ${trades.length} resolved sniper decisions\n`)

function stats(list) {
  const n = list.length
  if (n === 0) return { n: 0, totalR: 0, winRate: 0, avgR: 0, maxDD: 0 }
  const totalR = list.reduce((s, t) => s + t.r, 0)
  const wins = list.filter(t => t.r > 0).length
  let cum = 0, peak = 0, maxDD = 0
  for (const t of list) { cum += t.r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum) }
  return { n, totalR, winRate: wins / n, avgR: totalR / n, maxDD }
}

function runGate(killSwitch) {
  let gateEnabled = true
  let lastEval = 0
  const taken = [], blocked = []
  for (const t of trades) {
    if (killSwitch && t.entry - lastEval >= KILL_MS) {
      lastEval = t.entry
      const since = t.entry - KILL_MS
      if (gateEnabled) {
        const shadow24 = blocked.filter(x => x.entry >= since).reduce((s, x) => s + x.r, 0)
        if (shadow24 > 0) gateEnabled = false
      } else {
        const real24 = taken.filter(x => x.entry >= since).reduce((s, x) => s + x.r, 0)
        if (real24 < 0) gateEnabled = true
      }
    }
    const rollingR = taken
      .filter(x => x.resolved >= t.entry - WINDOW_MS && x.resolved <= t.entry)
      .reduce((s, x) => s + x.r, 0)
    if (gateEnabled && rollingR < 0) blocked.push(t)
    else taken.push(t)
  }
  return { taken, blocked }
}

function row(name, s, blockedN) {
  return {
    name,
    trades: s.n,
    blocked: blockedN,
    totalR: s.totalR.toFixed(2),
    winRate: (s.winRate * 100).toFixed(1) + "%",
    avgR: s.avgR.toFixed(3),
    maxDD_R: s.maxDD.toFixed(2),
  }
}

const base = stats(trades)
const simple = runGate(false)
const adaptive = runGate(true)

console.table([
  row("Baseline (ungated)", base, 0),
  row("Simple gate (6h)", stats(simple.taken), simple.blocked.length),
  row("Gate + kill-switch (24h)", stats(adaptive.taken), adaptive.blocked.length),
])

console.log("\nDirection breakdown (baseline → adaptive):")
for (const dir of ["long", "short"]) {
  const b = stats(trades.filter(t => t.dir === dir))
  const a = stats(adaptive.taken.filter(t => t.dir === dir))
  console.log(`  ${dir}: ${b.n}→${a.n} trades, totalR ${b.totalR.toFixed(2)}→${a.totalR.toFixed(2)}, winRate ${(b.winRate*100).toFixed(1)}%→${(a.winRate*100).toFixed(1)}%`)
}

await client.end()

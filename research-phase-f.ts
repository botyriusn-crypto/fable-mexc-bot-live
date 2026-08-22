const SPREAD: Record<string, number> = {
  BTC_USDT: .0001, ETH_USDT: .0001, SOL_USDT: .0002, AVAX_USDT: .0002, LINK_USDT: .0002, PEPE_USDT: .0008,
}
interface C { time: number; high: number; low: number; close: number }
async function fetchAll(sym: string, days: number): Promise<C[]> {
  const isec = 4 * 3600, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: C[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Hour4&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, high, low, close } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], high: high[i], low: low[i], close: close[i] })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}
function ema(v: number[], p: number): number[] { const o = [v[0]]; const k = 2 / (p + 1)
  for (let i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k); return o }
function atr(c: C[], p = 14): number[] { const o = new Array(c.length).fill(0); let a = 0
  for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    a = i <= p ? (a * (i - 1) + tr) / i : (a * (p - 1) + tr) / p; o[i] = a } return o }

function run(sym: string, c: C[], start: number, end: number, mode: "trend" | "break") {
  const sp = SPREAD[sym] ?? 0.001, LVL = 500
  const closes = c.map(x => x.close), e21 = ema(closes, 21), e55 = ema(closes, 55), a = atr(c)
  let pos: { side: 1 | -1; entry: number; q: number; stop: number; tp: number } | null = null
  let net = 0, n = 0, wins = 0
  const closePos = (price: number) => {
    if (!pos) return
    const g = (price - pos.entry) * pos.side * pos.q
    const cost = (pos.entry * pos.q + price * pos.q) * sp
    net += g - cost; n++; if (g - cost > 0) wins++
    pos = null
  }
  for (let i = Math.max(start, 60); i < end; i++) {
    const price = c[i].close
    if (pos) {
      if (pos.side === 1 && c[i].low <= pos.stop) closePos(pos.stop)
      else if (pos.side === -1 && c[i].high >= pos.stop) closePos(pos.stop)
      else if (pos.side === 1 && c[i].high >= pos.tp) closePos(pos.tp)
      else if (pos.side === -1 && c[i].low <= pos.tp) closePos(pos.tp)
      else if (mode === "trend") {
        const xUp = e21[i] > e55[i] && e21[i - 1] <= e55[i - 1], xDn = e21[i] < e55[i] && e21[i - 1] >= e55[i - 1]
        if ((pos.side === 1 && xDn) || (pos.side === -1 && xUp)) closePos(price)
      } else {
        const ll10 = Math.min(...c.slice(i - 10, i).map(x => x.low)), hh10 = Math.max(...c.slice(i - 10, i).map(x => x.high))
        if ((pos.side === 1 && price < ll10) || (pos.side === -1 && price > hh10)) closePos(price)
      }
    }
    if (!pos && i + 1 < end) {
      const q = LVL / price
      if (mode === "trend") {
        const xUp = e21[i] > e55[i] && e21[i - 1] <= e55[i - 1], xDn = e21[i] < e55[i] && e21[i - 1] >= e55[i - 1]
        if (xUp) pos = { side: 1, entry: price, q, stop: price - 2 * a[i], tp: price + 4 * a[i] }
        else if (xDn) pos = { side: -1, entry: price, q, stop: price + 2 * a[i], tp: price - 4 * a[i] }
      } else {
        const hh20 = Math.max(...c.slice(i - 20, i).map(x => x.high)), ll20 = Math.min(...c.slice(i - 20, i).map(x => x.low))
        if (price > hh20) pos = { side: 1, entry: price, q, stop: price - 3 * a[i], tp: price + 6 * a[i] }
        else if (price < ll20) pos = { side: -1, entry: price, q, stop: price + 3 * a[i], tp: price - 6 * a[i] }
      }
    }
  }
  if (pos) closePos(c[end - 1].close)
  return { n, net, wr: n ? 100 * wins / n : 0 }
}
async function main() {
  const symbols = Object.keys(SPREAD)
  const days = 400, W = 90 * 6
  for (const mode of ["trend", "break"] as const) {
    console.log(`\n=== 4H ${mode.toUpperCase()} ===`)
    console.log(" symbol       | trades |  WR%  | TOTAL (4x90d) | worst 90d")
    let posCount = 0, agg = 0
    for (const sym of symbols) {
      const c = await fetchAll(sym, days)
      if (c.length < W * 4 + 60) { console.log(`${sym}: not enough data`); continue }
      let tot = 0, worst = 1e9, tr = 0, wrSum = 0
      for (let w = 0; w < 4; w++) {
        const start = c.length - (4 - w) * W
        const r = run(sym, c, start, start + W, mode)
        tot += r.net; worst = Math.min(worst, r.net); tr += r.n; wrSum += r.wr
      }
      if (tot > 0) posCount++
      agg += tot
      console.log(` ${sym.padEnd(12)} | ${String(tr).padStart(6)} | ${(wrSum / 4).toFixed(0).padStart(4)} | ${tot.toFixed(0).padStart(13)} | ${worst.toFixed(0).padStart(9)}`)
    }
    console.log(` AGGREGATE: $${agg.toFixed(0)} | positive symbols: ${posCount}/${symbols.length}`)
  }
}
main()

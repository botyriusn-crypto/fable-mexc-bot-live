// Phase G: 4H breakout + direction gate (EMA200) + trend-strength gate (ADX>20), 2 years
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
function adx(c: C[], p = 14): number[] {
  const n = c.length, tr = new Array(n).fill(0), up0 = new Array(n).fill(0), dn0 = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low
    up0[i] = up > dn && up > 0 ? up : 0; dn0[i] = dn > up && dn > 0 ? dn : 0
  }
  const w = (arr: number[]) => { const o = new Array(n).fill(0); for (let i = 1; i < n; i++) o[i] = o[i - 1] - o[i - 1] / p + arr[i]; return o }
  const sTR = w(tr), sP = w(up0), sM = w(dn0), dx = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const pdi = sTR[i] ? 100 * sP[i] / sTR[i] : 0, mdi = sTR[i] ? 100 * sM[i] / sTR[i] : 0
    dx[i] = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0
  }
  const o = new Array(n).fill(0)
  for (let i = 1; i < n; i++) o[i] = o[i - 1] - o[i - 1] / p + dx[i] / p
  return o
}

function run(sym: string, c: C[], start: number, end: number, dir: boolean, useAdx: boolean) {
  const sp = SPREAD[sym] ?? 0.001, LVL = 500
  const closes = c.map(x => x.close), e200 = ema(closes, 200), a = atr(c), ax = useAdx ? adx(c) : null
  let pos: { side: 1 | -1; entry: number; q: number; stop: number; tp: number } | null = null
  let net = 0, n = 0, wins = 0
  const closePos = (price: number) => { if (!pos) return
    const g = (price - pos.entry) * pos.side * pos.q - (pos.entry * pos.q + price * pos.q) * sp
    net += g; n++; if (g > 0) wins++; pos = null }
  for (let i = Math.max(start, 210); i < end; i++) {
    const price = closes[i]
    if (pos) {
      if (pos.side === 1 && c[i].low <= pos.stop) closePos(pos.stop)
      else if (pos.side === -1 && c[i].high >= pos.stop) closePos(pos.stop)
      else if (pos.side === 1 && c[i].high >= pos.tp) closePos(pos.tp)
      else if (pos.side === -1 && c[i].low <= pos.tp) closePos(pos.tp)
      else { const ll10 = Math.min(...c.slice(i - 10, i).map(x => x.low)), hh10 = Math.max(...c.slice(i - 10, i).map(x => x.high))
        if ((pos.side === 1 && price < ll10) || (pos.side === -1 && price > hh10)) closePos(price) }
    }
    if (!pos && i + 1 < end) {
      const hh20 = Math.max(...c.slice(i - 20, i).map(x => x.high)), ll20 = Math.min(...c.slice(i - 20, i).map(x => x.low))
      const canLong = !dir || price > e200[i], canShort = !dir || price < e200[i]
      const adxOk = !ax || ax[i] > 20
      const q = LVL / price
      if (price > hh20 && canLong && adxOk) pos = { side: 1, entry: price, q, stop: price - 3 * a[i], tp: price + 6 * a[i] }
      else if (price < ll20 && canShort && adxOk) pos = { side: -1, entry: price, q, stop: price + 3 * a[i], tp: price - 6 * a[i] }
    }
  }
  if (pos) closePos(c[end - 1].close)
  return { n, net, wr: n ? 100 * wins / n : 0 }
}
async function main() {
  const symbols = Object.keys(SPREAD), days = 760, W = 180 * 6
  const configs: [string, boolean, boolean][] = [["break", false, false], ["+dir", true, false], ["+dir+adx", true, true]]
  console.log("2-year walk-forward (4 x 180d windows), 4H breakout variants\n")
  console.log(" symbol       | config     | trades |  WR%  | TOTAL (2yr) | worst 180d")
  for (const sym of symbols) {
    const c = await fetchAll(sym, days)
    if (c.length < W * 4 + 210) { console.log(`${sym}: not enough data (${c.length})`); continue }
    for (const [name, dir, useAdx] of configs) {
      let tot = 0, worst = 1e9, tr = 0, wrS = 0
      for (let w = 0; w < 4; w++) {
        const start = c.length - (4 - w) * W
        const r = run(sym, c, start, start + W, dir, useAdx)
        tot += r.net; worst = Math.min(worst, r.net); tr += r.n; wrS += r.wr
      }
      console.log(` ${sym.padEnd(12)} | ${name.padEnd(10)} | ${String(tr).padStart(6)} | ${(wrS / 4).toFixed(0).padStart(4)} | ${tot.toFixed(0).padStart(11)} | ${worst.toFixed(0).padStart(10)}`)
    }
    console.log("")
  }
  console.log("AGGREGATES:")
  for (const [name, dir, useAdx] of configs) {
    let agg = 0, pos = 0
    for (const sym of symbols) {
      const c = await fetchAll(sym, days)
      if (c.length < W * 4 + 210) continue
      let tot = 0
      for (let w = 0; w < 4; w++) { const start = c.length - (4 - w) * W; tot += run(sym, c, start, start + W, dir, useAdx).net }
      if (tot > 0) pos++; agg += tot
    }
    console.log(` ${name.padEnd(10)} | aggregate $${agg.toFixed(0)} | positive ${pos}/${symbols.length}`)
  }
}
main()

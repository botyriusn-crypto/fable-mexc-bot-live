const SPREAD: Record<string, number> = {
  BTC_USDT: .0001, SOL_USDT: .0002, AVAX_USDT: .0002, ETH_USDT: .0001, LINK_USDT: .0002,
}
interface Candle { time: number; close: number }
async function fetchAll(sym: string, days: number): Promise<Candle[]> {
  const isec = 900, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, close } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], close: close[i] })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}
function ema(v: number[], p: number): number[] { const o = [v[0]]; const k = 2 / (p + 1)
  for (let i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k); return o }

function gridWindow(sym: string, c: Candle[], spacing: number, depth: number, start: number, end: number, gate: boolean, stop: boolean) {
  const sp = SPREAD[sym] ?? 0.001, LVL = 500
  const e100 = ema(c.map(x => x.close), 100)
  let realized = 0, trades = 0, inv = 0, maxInv = 0, stops = 0, cooldown = 0
  let buys: { p: number; q: number }[] = [], sells: { p: number; q: number; bp: number }[] = []
  const place = (price: number) => { buys = []; for (let l = 1; l <= depth; l++) { const bp = price * (1 - spacing / 100 * l); buys.push({ p: bp, q: LVL / bp }) } }
  for (let i = start; i < end; i++) {
    const price = c[i].close
    const gated = gate && price < e100[i]
    if (stop && sells.length) {
      const invValue = sells.reduce((t, s) => t + s.bp * s.q, 0)
      const unreal = sells.reduce((t, s) => t + (price - s.bp) * s.q, 0)
      if (invValue > 0 && unreal / invValue < -0.015) {
        realized += unreal - invValue * sp
        sells = []; buys = []; stops++; cooldown = 96; trades++
      }
    }
    if (cooldown > 0) { cooldown--; continue }
    if (gated) buys = []
    else {
      const topBuy = buys.length ? Math.max(...buys.map(b => b.p)) : 0
      if (!buys.length && !sells.length) place(price)
      else if (!sells.length && topBuy && price > topBuy * (1 + (spacing * (depth + 1)) / 100)) place(price)
    }
    for (const b of [...buys]) if (!gated && price <= b.p) {
      buys = buys.filter(x => x !== b)
      sells.push({ p: b.p * (1 + spacing / 100), q: b.q, bp: b.p })
      inv += b.p * b.q; maxInv = Math.max(maxInv, inv)
    }
    for (const s of [...sells]) if (price >= s.p) {
      sells = sells.filter(x => x !== s)
      realized += (s.p - s.bp) * s.q - (s.p * s.q + s.bp * s.q) * sp
      inv -= s.bp * s.q; trades++
      if (!gated) buys.push({ p: s.bp, q: s.q })
    }
  }
  const last = c[end - 1].close
  const endUnreal = sells.reduce((t, s) => t + (last - s.bp) * s.q, 0)
  return { trades, realized, total: realized + endUnreal, stops }
}
async function main() {
  const symbols = ["BTC_USDT", "SOL_USDT", "AVAX_USDT", "ETH_USDT", "LINK_USDT"]
  const days = 150, W = 30 * 96
  const configs: [string, boolean, boolean][] = [["naive", false, false], ["gate", true, false], ["stop", false, true], ["gate+stop", true, true]]
  console.log(" symbol       | config    | trades | TOTAL (4mo) | worst mo | stops")
  for (const sym of symbols) {
    const c = await fetchAll(sym, days)
    if (c.length < W * 4 + 200) { console.log(`${sym}: not enough data`); continue }
    for (const [name, gate, stop] of configs) {
      let tot = 0, worst = 1e9, tr = 0, st = 0
      for (let w = 0; w < 4; w++) {
        const start = c.length - (4 - w) * W
        const r = gridWindow(sym, c, 0.30, 3, start, start + W, gate, stop)
        tot += r.total; worst = Math.min(worst, r.total); tr += r.trades; st += r.stops
      }
      console.log(` ${sym.padEnd(12)} | ${name.padEnd(9)} | ${String(tr).padStart(6)} | ${tot.toFixed(0).padStart(11)} | ${worst.toFixed(0).padStart(8)} | ${String(st).padStart(5)}`)
    }
    console.log("")
  }
}
main()

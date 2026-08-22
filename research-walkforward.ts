// Phase D: corrected accounting + upward re-centering + 4 walk-forward windows
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

interface Win { trades: number; realized: number; endInvValue: number; endUnrealized: number; maxInv: number }

function gridWindow(sym: string, c: Candle[], spacing: number, depth: number, start: number, end: number): Win {
  const sp = SPREAD[sym] ?? 0.001
  const LVL = 500
  let realized = 0, trades = 0, inv = 0, maxInv = 0
  let buys: { p: number; q: number }[] = [], sells: { p: number; q: number; bp: number }[] = []

  const place = (price: number) => {
    buys = []; for (let l = 1; l <= depth; l++) { const bp = price * (1 - spacing / 100 * l); buys.push({ p: bp, q: LVL / bp }) }
  }

  for (let i = start; i < end; i++) {
    const price = c[i].close
    // init or re-center upward when grid is stale (all sold, price ran away)
    const topBuy = buys.length ? Math.max(...buys.map(b => b.p)) : 0
    if (!buys.length && !sells.length) place(price)
    else if (!sells.length && topBuy && price > topBuy * (1 + (spacing * (depth + 1)) / 100)) place(price)

    for (const b of [...buys]) if (price <= b.p) {
      buys = buys.filter(x => x !== b)
      sells.push({ p: b.p * (1 + spacing / 100), q: b.q, bp: b.p })
      inv += b.p * b.q; maxInv = Math.max(maxInv, inv)
    }
    for (const s of [...sells]) if (price >= s.p) {
      sells = sells.filter(x => x !== s)
      realized += (s.p - s.bp) * s.q - (s.p * s.q + s.bp * s.q) * sp   // accounting ONLY on fill
      inv -= s.bp * s.q; trades++
      buys.push({ p: s.bp, q: s.q })
    }
  }
  const last = c[end - 1].close
  let endInvValue = 0, endUnrealized = 0
  for (const s of sells) { endInvValue += s.bp * s.q; endUnrealized += (last - s.bp) * s.q }
  return { trades, realized, endInvValue, endUnrealized, maxInv }
}

async function main() {
  const symbols = ["BTC_USDT", "SOL_USDT", "AVAX_USDT", "ETH_USDT", "LINK_USDT"]
  const days = 150, W = 30 * 96
  console.log("Walk-forward: 4 consecutive 30d windows, grid 0.30% depth 3, re-centering ON\n")
  console.log(" symbol       |  win  | trades | realized | end inventory | unrealized |  TOTAL  | maxInv")
  const summary: Record<string, { tot: number; worst: number }> = {}
  for (const sym of symbols) {
    const c = await fetchAll(sym, days)
    if (c.length < W * 4 + 200) { console.log(`${sym}: not enough data (${c.length})`); continue }
    let tot = 0, worst = 1e9
    for (let w = 0; w < 4; w++) {
      const start = c.length - (4 - w) * W, end = start + W
      const r = gridWindow(sym, c, 0.30, 3, start, end)
      const total = r.realized + r.endUnrealized
      tot += total; worst = Math.min(worst, total)
      console.log(` ${sym.padEnd(12)} |  W${w + 1}   | ${String(r.trades).padStart(6)} | ${r.realized.toFixed(0).padStart(8)} | $${r.endInvValue.toFixed(0).padStart(11)} | ${r.endUnrealized.toFixed(0).padStart(10)} | ${total.toFixed(0).padStart(7)} | $${r.maxInv.toFixed(0).padStart(5)}`)
    }
    summary[sym] = { tot, worst }
    console.log("")
  }
  console.log(" SUMMARY (4 months):")
  for (const s of Object.keys(summary)) {
    console.log(` ${s.padEnd(12)} | total $${summary[s].tot.toFixed(0).padStart(6)} | worst month $${summary[s].worst.toFixed(0).padStart(6)} | avg/mo $${(summary[s].tot / 4).toFixed(0)}`)
  }
}
main()

// Research harness: strategy classes x symbols, fee=0 (your account),
// but REALISTIC spread costs. Also reports net @ 0.02% fee (promo-end risk).
const FEE = 0
const FEE_ROBUST = 0.0002
const SPREAD: Record<string, number> = {
  BTC_USDT: .0001, ETH_USDT: .0001, SOL_USDT: .0002, BNB_USDT: .0002, XRP_USDT: .0002,
  DOGE_USDT: .0002, ADA_USDT: .0002, LINK_USDT: .0002, AVAX_USDT: .0002, LTC_USDT: .0002,
  PEPE_USDT: .0008, SHIB_USDT: .0008, FLOKI_USDT: .001, WIF_USDT: .0012, BONK_USDT: .001,
  PEOPLE_USDT: .0012, PUMPFUN_USDT: .0015, VELVET_USDT: .002, BEAT_USDT: .0015,
}
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchAll(sym: string, days = 30): Promise<Candle[]> {
  const isec = 900, es = Math.floor(Date.now() / 1000), ss = es - days * 86400
  const all: Candle[] = []; let fe = es
  while (true) {
    const fs = Math.max(ss, fe - 2000 * isec)
    try {
      const j = await (await fetch(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&start=${fs}&end=${fe}`)).json() as any
      if (!j.success || !j.data?.time?.length) break
      const { time, open, high, low, close, vol } = j.data
      for (let i = 0; i < time.length; i++) all.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
      if (time[0] <= ss || time.length < 100) break
      fe = time[0] - isec
    } catch { break }
  }
  all.sort((a, b) => a.time - b.time)
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time)
}

function rsi(c: number[], p: number): number[] { const o = new Array(c.length).fill(50); let ag = 0, al = 0
  for (let i = 1; i < c.length; i++) { const ch = c[i] - c[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0)
    if (i <= p) { ag += g / p; al += l / p } else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p }
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al) } return o }
function ema(v: number[], p: number): number[] { const o = [v[0]]; const k = 2 / (p + 1)
  for (let i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k); return o }
function atr(c: Candle[], p = 14): number[] { const o = new Array(c.length).fill(0); let a = 0
  for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close))
    a = i <= p ? (a * (i - 1) + tr) / i : (a * (p - 1) + tr) / p; o[i] = a } return o }

interface Row { strat: string; sym: string; n: number; wr: number; net0: number; net2: number; ret: number; mdd: number }
const rows: Row[] = []

function sim(name: string, sym: string, fills: { notional: number; gross: number }[]) {
  const sp = SPREAD[sym] ?? 0.001
  let equity = 10000, peak = 10000, mdd = 0, wins = 0
  let spread = 0, fees2 = 0, gross = 0
  for (const f of fills) {
    const cost = f.notional * sp + f.notional * FEE
    const cost2 = f.notional * sp + f.notional * FEE_ROBUST
    gross += f.gross; spread += f.notional * sp; fees2 += f.notional * FEE_ROBUST
    equity += f.gross - cost
    if (f.gross - cost > 0) wins++
    peak = Math.max(peak, equity); mdd = Math.min(mdd, (equity - peak) / peak * 100)
  }
  const net0 = gross - spread, net2 = gross - spread - fees2
  rows.push({ strat: name, sym, n: fills.length, wr: fills.length ? 100 * wins / fills.length : 0, net0, net2, ret: (equity - 10000) / 100, mdd })
}

function grid(sym: string, c: Candle[], spacing: number) {
  const fills: { notional: number; gross: number }[] = []
  let buys: { p: number; q: number }[] = [], sells: { p: number; q: number; bp: number }[] = []
  for (let i = 200; i < c.length; i++) {
    const price = c[i].close
    if (!buys.length && !sells.length) for (let l = 1; l <= 5; l++) { const bp = price * (1 - spacing / 100 * l); buys.push({ p: bp, q: 500 / bp }) }
    for (const b of [...buys]) if (price <= b.p) { buys = buys.filter(x => x !== b); sells.push({ p: b.p * (1 + spacing / 100), q: b.q, bp: b.p }) }
    for (const s of [...sells]) if (price >= s.p) { sells = sells.filter(x => x !== s)
      fills.push({ notional: s.p * s.q + s.bp * s.q, gross: (s.p - s.bp) * s.q })
      buys.push({ p: s.bp, q: s.q }) }
  }
  sim(`GRID ${spacing}%`, sym, fills)
}

function meanrev(sym: string, c: Candle[]) {
  const r = rsi(c.map(x => x.close), 14), a = atr(c), fills: { notional: number; gross: number }[] = []
  let pos: { side: 1 | -1; entry: number; q: number; sl: number; tp: number } | null = null
  for (let i = 200; i < c.length; i++) {
    const price = c[i].close
    if (pos) {
      const hit = (pos.side === 1 && (price <= pos.sl || price >= pos.tp)) || (pos.side === -1 && (price >= pos.sl || price <= pos.tp))
      if (hit) { fills.push({ notional: pos.entry * pos.q + price * pos.q, gross: (price - pos.entry) * pos.side * pos.q }); pos = null }
    } else if (r[i] <= 20 || r[i] >= 80) {
      const side: 1 | -1 = r[i] <= 20 ? 1 : -1, q = 500 / price
      pos = { side, entry: price, q, sl: price - side * a[i], tp: price + side * 3 * a[i] }
    }
  }
  sim("MEANREV", sym, fills)
}

function trend(sym: string, c: Candle[]) {
  const e9 = ema(c.map(x => x.close), 9), e21 = ema(c.map(x => x.close), 21)
  const fills: { notional: number; gross: number }[] = []
  let pos: { side: 1 | -1; entry: number; q: number } | null = null
  for (let i = 201; i < c.length; i++) {
    const crossUp = e9[i] > e21[i] && e9[i - 1] <= e21[i - 1], crossDn = e9[i] < e21[i] && e9[i - 1] >= e21[i - 1]
    const price = c[i].close
    if (pos && ((pos.side === 1 && crossDn) || (pos.side === -1 && crossUp))) {
      fills.push({ notional: pos.entry * pos.q + price * pos.q, gross: (price - pos.entry) * pos.side * pos.q }); pos = null }
    if (!pos && (crossUp || crossDn)) pos = { side: crossUp ? 1 : -1, entry: price, q: 500 / price }
  }
  sim("TREND", sym, fills)
}

async function main() {
  const majors = ["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT","DOGE_USDT","ADA_USDT","LINK_USDT","AVAX_USDT","LTC_USDT"]
  const micros = ["PEPE_USDT","SHIB_USDT","FLOKI_USDT","WIF_USDT","BONK_USDT","PEOPLE_USDT","PUMPFUN_USDT","VELVET_USDT","BEAT_USDT"]
  for (const s of [...majors, ...micros]) {
    const c = await fetchAll(s)
    if (c.length < 300) { console.log(`${s}: not enough data`); continue }
    const isMajor = majors.includes(s)
    grid(s, c, isMajor ? 0.2 : 0.5)
    meanrev(s, c)
    trend(s, c)
  }
  rows.sort((a, b) => b.net0 - a.net0)
  console.log("\n strat        | symbol       |  n  |  WR%  |  net@0fee | net@0.02% | ret%  | maxDD%")
  for (const r of rows)
    console.log(` ${r.strat.padEnd(12)} | ${r.sym.padEnd(12)} | ${String(r.n).padStart(3)} | ${r.wr.toFixed(0).padStart(4)} | ${r.net0.toFixed(1).padStart(9)} | ${r.net2.toFixed(1).padStart(9)} | ${r.ret.toFixed(1).padStart(5)} | ${r.mdd.toFixed(1).padStart(5)}`)
}
main()

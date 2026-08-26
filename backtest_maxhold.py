#!/usr/bin/env python3
"""
Grid max-hold backtest: 240m (range) vs 60m (trend) regime-aware policy.

Pulls historical klines from Bybit (public API, no keys), replays the grid's
mean-reversion cycle with the exact constants from lib/grid.ts / indicators.ts,
and compares max-hold policies. No dependence on the corrupted live DB.

v2 fixes:
  - Lookahead bias: orders placed at a candle's close only fill on LATER candles.
  - Pagination: fetches a full month (or more) of klines, not just 200.
  - Fee model: TP = maker (0 fee); SL/max-hold = taker (0.0002 on exit).
"""
import requests, time, sys
from typing import List, Dict, Tuple, Optional

# ---- Constants (verbatim from source) ----
TAKER_FEE = 0.0002
MAKER_FEE = 0.0000
MAKER_STOP_LOSS_PCT = 0.04
GRID_STOP_LOSS_PCT = 0.05
MAKER_MAX_HOLD_MINUTES = 240
TREND_MAX_HOLD_MINUTES = 60
GRID_ADX_THRESHOLD = 32
EMA_FAST = 9
EMA_SLOW = 21
ATR_PERIOD = 14
ADX_PERIOD = 14
RANGE_ATR_MULT = 0.5          # schema default; grid-sizing uses 1.5, rotator 1.0
MAX_ORDERS = 8
RECENTER_DRIFT_PCT = 0.15

BASE_URL = "https://api.bybit.com/v5"
HEADERS = {"Referer": "https://www.bybit.com"}

# ---- Indicators (match lib/indicators.ts) ----
def ema(values: List[float], period: int) -> List[float]:
    k = 2 / (period + 1)
    out = []
    prev = values[0]
    for i, v in enumerate(values):
        prev = v if i == 0 else v * k + prev * (1 - k)
        out.append(prev)
    return out

def atr(candles: List[dict], period: int = ATR_PERIOD) -> List[float]:
    n = len(candles)
    out = [0.0] * n
    if n <= period:
        return out
    trs = []
    for i in range(1, n):
        h, l, pc = candles[i]["high"], candles[i]["low"], candles[i-1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    # Wilder smoothing
    first = sum(trs[:period]) / period
    out[period] = first
    for i in range(period + 1, n):
        out[i] = (out[i-1] * (period - 1) + trs[i-1]) / period
    return out

def adx(candles: List[dict], period: int = ADX_PERIOD) -> List[float]:
    n = len(candles)
    if n < period * 2 + 1:
        return [0.0] * n
    plus_dm, minus_dm, tr = [], [], []
    for i in range(1, n):
        up = candles[i]["high"] - candles[i-1]["high"]
        down = candles[i-1]["low"] - candles[i]["low"]
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)
        h, l, pc = candles[i]["high"], candles[i]["low"], candles[i-1]["close"]
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))

    def wilder(arr):
        s = sum(arr[:period])
        out = [s]
        for i in range(period, len(arr)):
            s = s - s / period + arr[i]
            out.append(s)
        return out

    tr_s = wilder(tr)
    pdm_s = wilder(plus_dm)
    mdm_s = wilder(minus_dm)
    dx = []
    for i in range(len(tr_s)):
        pdi = 100 * pdm_s[i] / tr_s[i] if tr_s[i] else 0
        mdi = 100 * mdm_s[i] / tr_s[i] if tr_s[i] else 0
        denom = pdi + mdi
        dx.append(100 * abs(pdi - mdi) / denom if denom else 0)

    adx_out = [0.0] * n
    if len(dx) >= period:
        s = sum(dx[:period])
        adx_out[period * 2] = s / period
        for i in range(period, len(dx)):
            s = s - s / period + dx[i]
            idx = period * 2 + (i - period) + 1
            if idx < n:
                adx_out[idx] = s / period
    return adx_out

# ---- Kline fetch with pagination (match lib/bybit/public.ts) ----
INTERVAL_MAP = {"Min1":"1","Min5":"5","Min15":"15","Min30":"30","Min60":"60","Hour4":"240","Day1":"D"}

def fetch_klines(symbol: str, interval: str, total: int = 2880) -> List[dict]:
    """Fetch up to `total` candles, paginating backwards via the `end` param."""
    sym = symbol.replace("_", "")
    iv = INTERVAL_MAP.get(interval, "5")
    all_candles: List[dict] = []
    end_ms = None
    while len(all_candles) < total:
        limit = min(1000, total - len(all_candles))
        url = f"{BASE_URL}/market/kline?category=linear&symbol={sym}&interval={iv}&limit={limit}"
        if end_ms:
            url += f"&end={end_ms}"
        for attempt in range(3):
            r = requests.get(url, headers=HEADERS, timeout=15)
            j = r.json()
            if j.get("retCode") != 0:
                if j.get("retCode") == 10006 and attempt < 2:
                    time.sleep(0.5 * (attempt + 1)); continue
                raise RuntimeError(f"Bybit kline error {j.get('retCode')}: {j.get('retMsg')}")
            break
        lst = j.get("result", {}).get("list", [])
        if not lst:
            break
        # Bybit returns newest-first; build oldest-first batch
        batch = []
        for c in reversed(lst):
            batch.append({
                "time": int(c[0]) // 1000,
                "open": float(c[1]), "high": float(c[2]),
                "low": float(c[3]), "close": float(c[4]), "volume": float(c[5]),
            })
        all_candles = batch + all_candles
        oldest_ts = int(lst[-1][0])  # oldest in newest-first list
        end_ms = oldest_ts - 1
        if len(lst) < limit:
            break
    return all_candles

# ---- Grid simulation (no lookahead) ----
class Position:
    def __init__(self, entry, entry_time, tp):
        self.entry = entry
        self.entry_time = entry_time
        self.tp = tp

def should_enter(entry_filter, ema_f, ema_s, price, adx_val):
    """Entry gate. Returns True if a new resting buy may be placed this candle."""
    if entry_filter == "none":
        return True
    if entry_filter == "above_slow_ema":
        # Only buy when price is above the slow EMA (21) — avoid catching falling knives.
        return price > ema_s
    if entry_filter == "ema_trend":
        # Only buy when bullish alignment (emaFast > emaSlow).
        return ema_f > ema_s
    if entry_filter == "adx_range_only":
        # Only buy in genuine ranges (ADX <= 20). Skip the 20-32 "rising" band
        # where mean-reversion thesis is weakest and max-hold dumps cluster.
        return adx_val <= 20.0
    if entry_filter == "above_slow_ema_and_range":
        # Combine Filter 1 + ADX range gate.
        return price > ema_s and adx_val <= 20.0
    return True

def simulate(candles, max_hold_range, max_hold_trend, range_atr_mult, entry_filter="none", loss_cap=None, flow_window_hours=None, flow_confirm_hours=None, adaptive_refs=None, meta_window_hours=24, return_closed=False):
    """Bar-by-bar replay. Orders placed at a candle's close fill only on LATER candles.
    loss_cap: if set (e.g. 0.02), exit early when adverse move >= loss_cap (before max-hold).
    flow_window_hours: if set, pause NEW entries when trailing realized PnL over this
    window is <= 0 ("be like water" — trade only while in flow).
    flow_confirm_hours: if set, require BOTH the fast window AND this slower window to be
    negative before pausing (multi-timeframe confirmation to reduce whipsaw).
    adaptive_refs: tuple (base_closed, f6_closed) of (time, pnl) lists; when set, the gate
    only applies if the gated policy's trailing PnL >= ungated's (meta kill-switch).
    return_closed: if True, return (trades, closed_pnl) instead of just trades."""
    closes = [c["close"] for c in candles]
    atr_arr = atr(candles, ATR_PERIOD)
    adx_arr = adx(candles, ADX_PERIOD)
    ema_f = ema(closes, EMA_FAST)
    ema_s = ema(closes, EMA_SLOW)

    trades = []
    open_positions: List[Position] = []
    resting_buys: List[float] = []
    closed_pnl: List[Tuple[float, float]] = []  # (close_time, pnl%) for flow gate

    warmup = ADX_PERIOD * 2 + 1
    for i in range(warmup, len(candles)):
        c = candles[i]
        price = c["close"]
        a = atr_arr[i] if atr_arr[i] > 0 else price * 0.001
        adx_val = adx_arr[i]
        paused = adx_val >= GRID_ADX_THRESHOLD
        spacing = a * range_atr_mult

        # 1. TP fills for positions opened in PRIOR candles
        for p in list(open_positions):
            if c["high"] >= p.tp:
                pnl = (p.tp - p.entry) / p.entry * 100
                trades.append((pnl, "tp", (c["time"] - p.entry_time) / 60))
                closed_pnl.append((c["time"], pnl))
                open_positions.remove(p)

        # 2. Stop-loss (4% adverse vs close)
        for p in list(open_positions):
            adverse = (p.entry - price) / p.entry
            if adverse >= MAKER_STOP_LOSS_PCT:
                pnl = -MAKER_STOP_LOSS_PCT * 100
                trades.append((pnl, "stop-loss", (c["time"] - p.entry_time) / 60))
                closed_pnl.append((c["time"], pnl))
                open_positions.remove(p)

        # 3a. Loss cap: exit early if underwater by >= loss_cap (bounds the bleed)
        if loss_cap is not None:
            for p in list(open_positions):
                adverse = (p.entry - price) / p.entry
                if adverse >= loss_cap:
                    pnl = -loss_cap * 100
                    trades.append((pnl, "loss-cap", (c["time"] - p.entry_time) / 60))
                    closed_pnl.append((c["time"], pnl))
                    open_positions.remove(p)

        # 3. Max-hold (regime-aware)
        max_hold = max_hold_trend if paused else max_hold_range
        for p in list(open_positions):
            held_min = (c["time"] - p.entry_time) / 60
            if held_min >= max_hold:
                pnl = (price - p.entry) / p.entry * 100
                trades.append((pnl, "max-hold", held_min))
                closed_pnl.append((c["time"], pnl))
                open_positions.remove(p)

        # 4. Fill resting buys (placed in prior candles); TP checked next candle
        filled = [b for b in resting_buys if c["low"] <= b]
        for b in filled:
            open_positions.append(Position(b, c["time"], b + spacing))
        resting_buys = [b for b in resting_buys if b not in filled]

        # 5. Place new resting buy one spacing below close (fillable next candle)
        in_flow = True
        if flow_window_hours is not None:
            window_sec = flow_window_hours * 3600
            recent = [pnl for (t, pnl) in closed_pnl if c["time"] - t <= window_sec]
            fast_neg = (sum(recent) <= 0) if recent else False  # no data -> not negative
            if adaptive_refs is not None:
                base_closed, f6_closed = adaptive_refs
                meta_sec = meta_window_hours * 3600
                tb = sum(pnl for (t, pnl) in base_closed if c["time"] - t <= meta_sec)
                tf = sum(pnl for (t, pnl) in f6_closed if c["time"] - t <= meta_sec)
                gate_helps = tf >= tb  # gate only if it's beating ungated recently
                in_flow = (not fast_neg) if gate_helps else True
            elif flow_confirm_hours is not None:
                confirm_sec = flow_confirm_hours * 3600
                recent_c = [pnl for (t, pnl) in closed_pnl if c["time"] - t <= confirm_sec]
                slow_neg = (sum(recent_c) <= 0) if recent_c else False
                in_flow = not (fast_neg and slow_neg)  # pause only if BOTH negative
            else:
                in_flow = not fast_neg
        if len(resting_buys) + len(open_positions) < MAX_ORDERS:
            if in_flow and should_enter(entry_filter, ema_f[i], ema_s[i], price, adx_val):
                new_buy = price - spacing
                if new_buy > 0 and new_buy not in resting_buys:
                    resting_buys.append(new_buy)

    if return_closed:
        return trades, closed_pnl
    return trades

def apply_fees(trades):
    """TP = maker (0 fee); SL/max-hold = taker (0.0002 on exit)."""
    out = []
    for pnl, reason, held in trades:
        fee_pct = 0.0 if reason == "tp" else TAKER_FEE * 100
        out.append((pnl - fee_pct, reason, held))
    return out

def summarize(trades, label):
    if not trades:
        print(f"\n=== {label} ===\n  no trades")
        return
    net = sum(t[0] for t in trades)
    avg = net / len(trades)
    print(f"\n=== {label} ===")
    print(f"  trades: {len(trades)}  net PnL%: {net:.2f}  avg: {avg:.3f}%")
    by_reason = {}
    for pnl, reason, held in trades:
        by_reason.setdefault(reason, []).append((pnl, held))
    for reason, items in sorted(by_reason.items(), key=lambda x: sum(i[0] for i in x[1])):
        n = len(items)
        s = sum(i[0] for i in items)
        a = s / n
        avg_held = sum(i[1] for i in items) / n
        print(f"  {reason:10s} n={n:3d}  net={s:8.2f}%  avg={a:7.3f}%  avg_hold={avg_held:5.1f}m")

DEFAULT_BASKET = ["ENA_USDT", "HYPE_USDT", "XRP_USDT", "SOL_USDT", "WIF_USDT",
                 "1000PEPE_USDT", "DOGE_USDT", "SUI_USDT", "BTC_USDT", "ETH_USDT",
                 "LINK_USDT", "AVAX_USDT", "ARB_USDT", "OP_USDT", "TIA_USDT",
                 "SEI_USDT", "INJ_USDT", "APT_USDT", "NEAR_USDT", "ATOM_USDT"]

def run_symbol(symbol, interval, mult, total):
    """Run baseline vs 6h flow vs adaptive kill-switch (6h + meta gate)."""
    candles = fetch_klines(symbol, interval, total)
    if len(candles) < ADX_PERIOD * 2 + 2:
        return None
    base_trades, base_closed = simulate(candles, MAKER_MAX_HOLD_MINUTES, TREND_MAX_HOLD_MINUTES, mult, "none", return_closed=True)
    f6_trades, f6_closed = simulate(candles, MAKER_MAX_HOLD_MINUTES, TREND_MAX_HOLD_MINUTES, mult, "none", flow_window_hours=6, return_closed=True)
    adapt = apply_fees(simulate(candles, MAKER_MAX_HOLD_MINUTES, TREND_MAX_HOLD_MINUTES, mult, "none", flow_window_hours=6, adaptive_refs=(base_closed, f6_closed), meta_window_hours=24))
    base_net = sum(t[0] for t in apply_fees(base_trades))
    f6_net = sum(t[0] for t in apply_fees(f6_trades))
    adapt_net = sum(t[0] for t in adapt)
    return base_net, f6_net, adapt_net, len(base_trades)

WINDOWS = [(2880, "30d"), (5760, "60d"), (8640, "90d")]

def main():
    interval = sys.argv[1] if len(sys.argv) > 1 else "Min15"
    mult = float(sys.argv[2]) if len(sys.argv) > 2 else RANGE_ATR_MULT
    symbols = sys.argv[3:] if len(sys.argv) > 3 else DEFAULT_BASKET

    print(f"WIDE VALIDATION: {len(symbols)} symbols x {len(WINDOWS)} windows, {interval}, rangeAtrMult={mult}")
    print("=" * 78)

    # Aggregate results across all windows
    all_rows = []  # (window_label, sym, base, f6, adapt, d6, dadapt)

    for total, wlabel in WINDOWS:
        print(f"\n--- Window: {wlabel} ({total} candles) ---")
        print(f"{'symbol':12s} {'base%':>9s} {'f6h%':>9s} {'adapt%':>9s} {'d6':>8s} {'dadapt':>8s}")
        print("-" * 60)

        rows = []
        for sym in symbols:
            try:
                r = run_symbol(sym, interval, mult, total)
            except Exception as e:
                print(f"{sym:12s}  ERROR: {e}")
                continue
            if r is None:
                print(f"{sym:12s}  insufficient data")
                continue
            base_net, f6_net, adapt_net, n = r
            d6 = f6_net - base_net
            dadapt = adapt_net - base_net
            rows.append((sym, base_net, f6_net, adapt_net, d6, dadapt))
            all_rows.append((wlabel, sym, base_net, f6_net, adapt_net, d6, dadapt))
            print(f"{sym:12s} {base_net:9.2f} {f6_net:9.2f} {adapt_net:9.2f} {d6:+8.2f} {dadapt:+8.2f}")

        if rows:
            n = len(rows)
            avg_base = sum(r[1] for r in rows) / n
            avg_f6 = sum(r[2] for r in rows) / n
            avg_adapt = sum(r[3] for r in rows) / n
            avg_d6 = sum(r[4] for r in rows) / n
            avg_dadapt = sum(r[5] for r in rows) / n
            print("-" * 60)
            print(f"{'AVERAGE':12s} {avg_base:9.2f} {avg_f6:9.2f} {avg_adapt:9.2f} {avg_d6:+8.2f} {avg_dadapt:+8.2f}")
            wins6 = sum(1 for r in rows if r[4] > 0)
            winsadapt = sum(1 for r in rows if r[5] > 0)
            print(f"  6h alone improved {wins6}/{n} | adaptive improved {winsadapt}/{n}")

    # Cross-window summary
    print("\n" + "=" * 78)
    print("CROSS-WINDOW SUMMARY (adaptive kill-switch)")
    print(f"{'window':8s} {'avg_base%':>10s} {'avg_adapt%':>10s} {'avg_delta':>10s} {'wins':>6s}")
    print("-" * 50)
    for total, wlabel in WINDOWS:
        wr = [r for r in all_rows if r[0] == wlabel]
        if not wr:
            continue
        n = len(wr)
        avg_base = sum(r[2] for r in wr) / n
        avg_adapt = sum(r[4] for r in wr) / n
        avg_delta = sum(r[6] for r in wr) / n
        wins = sum(1 for r in wr if r[6] > 0)
        print(f"{wlabel:8s} {avg_base:10.2f} {avg_adapt:10.2f} {avg_delta:+10.2f} {wins:5d}/{n}")

    # Per-symbol robustness: how many windows did adaptive improve?
    print("\nPER-SYMBOL ROBUSTNESS (adaptive improved in how many windows)")
    print(f"{'symbol':12s} {'wins':>6s}")
    print("-" * 20)
    syms = sorted(set(r[1] for r in all_rows))
    for sym in syms:
        sr = [r for r in all_rows if r[1] == sym]
        wins = sum(1 for r in sr if r[6] > 0)
        print(f"{sym:12s} {wins:5d}/{len(sr)}")

if __name__ == "__main__":
    main()

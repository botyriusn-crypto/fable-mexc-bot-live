#!/usr/bin/env python3
"""
Grid paper-reconciliation checker.

Measures the gap between the backtested (modeled) grid edge and the bot's
ACTUAL fills, to confirm the validated edge survives real execution before
scaling size.

Modeled side: replays backtest_maxhold.simulate() over the same candles.
Actual side:  reads the `trades` table (strategy='grid').

Usage:
  python3 grid_reconcile.py [--mult 0.5] [--interval Min15] [--days 30] [--total 2880]

Output: per-symbol + aggregate comparison of modeled vs actual expectancy.
"""

import os, sys, argparse
from collections import defaultdict
import backtest_maxhold as bt

# Validated OOS walk-forward basket (lib/validated-symbols.ts). Only these
# symbols have a Bybit market AND a validated edge worth reconciling. Legacy
# microcaps (BEAT, BLESS, SOPH, BNC, WAVES, CP, XCN, AAVE, UNI, ...) are listed
# on MEXC but NOT on Bybit, so fetch_klines returns "Symbol Is Invalid" for
# them — filter them out here rather than erroring on every run.
VALIDATED_BASKET = {
    "ENA_USDT", "HYPE_USDT", "XRP_USDT", "SOL_USDT", "WIF_USDT",
    "1000PEPE_USDT", "DOGE_USDT", "SUI_USDT", "BTC_USDT", "ETH_USDT",
    "LINK_USDT", "AVAX_USDT", "ARB_USDT", "OP_USDT", "TIA_USDT",
    "SEI_USDT", "INJ_USDT", "APT_USDT", "NEAR_USDT", "ATOM_USDT",
}

# ---------------------------------------------------------------------------
# DB access
# ---------------------------------------------------------------------------
def get_db_url():
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    for p in (".env", ".env.local"):
        if os.path.exists(p):
            for line in open(p):
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DATABASE_URL not found in env or .env")

def fetch_actual_trades(days):
    try:
        import psycopg2
    except ImportError:
        raise SystemExit("psycopg2 not installed — run: pip install psycopg2-binary")
    conn = psycopg2.connect(get_db_url())
    cur = conn.cursor()
    cur.execute(
        """
        SELECT symbol, side, entry_price, exit_price, size_usdt, pnl, fees, exit_reason, opened_at, closed_at
        FROM trades
        WHERE strategy = 'grid' AND closed_at > now() - make_interval(days => %s)
        ORDER BY symbol, closed_at
        """,
        (days,),
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close(); conn.close()
    return rows

# ---------------------------------------------------------------------------
# Modeled replay (reuses the real backtest model)
# ---------------------------------------------------------------------------
def modeled_expectancy(symbol, interval, mult, total):
    try:
        candles = bt.fetch_klines(symbol, interval, total)
    except Exception as e:
        print(f"  (skip {symbol}: fetch failed — {e})")
        return None
    if len(candles) < bt.ADX_PERIOD * 2 + 2:
        return None

    # base config (no flow gate)
    base = bt.apply_fees(bt.simulate(
        candles, bt.MAKER_MAX_HOLD_MINUTES, bt.TREND_MAX_HOLD_MINUTES, mult, "none"))

    # adaptive config (flow-gated — the validated one)
    b_t, b_c = bt.simulate(
        candles, bt.MAKER_MAX_HOLD_MINUTES, bt.TREND_MAX_HOLD_MINUTES, mult, "none",
        return_closed=True)
    f_t, f_c = bt.simulate(
        candles, bt.MAKER_MAX_HOLD_MINUTES, bt.TREND_MAX_HOLD_MINUTES, mult, "none",
        flow_window_hours=6, return_closed=True)
    adapt = bt.apply_fees(bt.simulate(
        candles, bt.MAKER_MAX_HOLD_MINUTES, bt.TREND_MAX_HOLD_MINUTES, mult, "none",
        flow_window_hours=6, adaptive_refs=(b_c, f_c), meta_window_hours=24))

    def summarize(trades):
        if not trades:
            return (0, 0.0, 0.0)
        pnls = [t[0] for t in trades]
        return (len(trades), sum(pnls), sum(pnls) / len(trades))

    return {"base": summarize(base), "adaptive": summarize(adapt)}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mult", type=float, default=bt.RANGE_ATR_MULT)
    ap.add_argument("--interval", default="Min15")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--total", type=int, default=2880)
    args = ap.parse_args()

    print(f"GRID RECONCILIATION | mult={args.mult} interval={args.interval} days={args.days} total={args.total}")
    print(f"NOTE: backtest default RANGE_ATR_MULT={bt.RANGE_ATR_MULT}; live grid-sizing uses 1.5, rotator 1.0.")
    print()

    actual = fetch_actual_trades(args.days)
    if not actual:
        print("No actual grid trades found in window.")
        return

    # Drop legacy microcaps that have no Bybit market (would error on kline
    # fetch). Reconcile only the validated basket.
    dropped = sorted({t["symbol"] for t in actual} - VALIDATED_BASKET)
    actual = [t for t in actual if t["symbol"] in VALIDATED_BASKET]
    if dropped:
        print("SKIPPED non-basket symbols (no Bybit market):", dropped)
        print()
    if not actual:
        print("All actual grid trades were non-basket symbols; nothing to reconcile.")
        return

    by_sym = defaultdict(list)
    for t in actual:
        by_sym[t["symbol"]].append(t)

    hdr = f"{'symbol':<16} {'n_act':>5} {'act_avg%':>9} {'act_net%':>9} | {'n_mod':>5} {'mod_avg%':>9} {'mod_net%':>9} | {'leak%':>8}"
    print(hdr)
    print("-" * len(hdr))

    tot_act_n = 0; tot_act_net = 0.0
    tot_mod_n = 0; tot_mod_net = 0.0

    for sym, trades in sorted(by_sym.items()):
        act_pcts = []
        for t in trades:
            size = float(t["size_usdt"] or 0)
            pnl = float(t["pnl"] or 0)
            if size > 0:
                act_pcts.append(pnl / size * 100)
        n_act = len(act_pcts)
        act_avg = sum(act_pcts) / n_act if n_act else 0.0
        act_net = sum(act_pcts)

        m = modeled_expectancy(sym, args.interval, args.mult, args.total)
        if m is None:
            print(f"{sym:<16} {n_act:>5} {act_avg:>9.3f} {act_net:>9.2f} | {'(no candles)':>30}")
            continue

        n_mod, mod_net, mod_avg = m["adaptive"]
        leak = mod_avg - act_avg
        print(f"{sym:<16} {n_act:>5} {act_avg:>9.3f} {act_net:>9.2f} | {n_mod:>5} {mod_avg:>9.3f} {mod_net:>9.2f} | {leak:>8.3f}")

        tot_act_n += n_act; tot_act_net += act_net
        tot_mod_n += n_mod; tot_mod_net += mod_net

    print("-" * len(hdr))
    if tot_act_n:
        a_avg = tot_act_net / tot_act_n
        m_avg = tot_mod_net / tot_mod_n if tot_mod_n else 0.0
        print(f"{'AGGREGATE':<16} {tot_act_n:>5} {a_avg:>9.3f} {tot_act_net:>9.2f} | {tot_mod_n:>5} {m_avg:>9.3f} {tot_mod_net:>9.2f} | {m_avg - a_avg:>8.3f}")

    print()
    print("leak% = modeled avg pnl% per trade − actual avg pnl% per trade.")
    print("Positive leak = losing edge to execution/config drift. Negative = live beats model.")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# oos_grid_validate.py — train/OOS split validation for the grid backtest.
# Imports simulate/apply_fees/fetch_klines from backtest_maxhold.py (no edits to it).
# Selects hold policy on TRAIN, measures PnL on OOS (unseen). This is the test
# the in-sample sweep never did.
#
# Usage: python3 oos_grid_validate.py [interval] [mult] [SYM ...]
#   defaults: interval=Min15, mult from backtest_maxhold, basket=DEFAULT_BASKET

import sys

import backtest_maxhold as bt

SPLIT = 0.6          # 60% train / 40% OOS
TOTAL = 8640         # candles to fetch (~90d at Min15) — matches the 90d window

def run_symbol_oos(symbol, interval, mult, total, split=SPLIT):
    candles = bt.fetch_klines(symbol, interval, total)
    if candles is None or len(candles) < bt.ADX_PERIOD * 2 + 2:
        return None
    n = len(candles)
    cut = int(n * split)
    train, oos = candles[:cut], candles[cut:]
    if len(train) < bt.ADX_PERIOD * 2 + 2 or len(oos) < bt.ADX_PERIOD * 2 + 2:
        return None

    # --- Select best hold policy on TRAIN only ---
    best_policy, best_train_net = None, float("-inf")
    for hr, ht in bt.HOLD_POLICIES:
        t = bt.apply_fees(bt.simulate(train, hr, ht, mult, "none"))
        net = sum(x[0] for x in t)
        if net > best_train_net:
            best_train_net, best_policy = net, (hr, ht)

    hr, ht = best_policy

    # --- Measure the FROZEN policy on OOS (base, ungated) ---
    base_oos_trades = bt.apply_fees(bt.simulate(oos, hr, ht, mult, "none"))
    base_oos_net = sum(x[0] for x in base_oos_trades)

    # --- Does the adaptive kill-switch beat base on OOS? ---
    _, base_closed = bt.simulate(oos, hr, ht, mult, "none", return_closed=True)
    _, f6_closed   = bt.simulate(oos, hr, ht, mult, "none",
                                 flow_window_hours=6, return_closed=True)
    adapt_oos_trades = bt.apply_fees(bt.simulate(
        oos, hr, ht, mult, "none",
        flow_window_hours=6,
        adaptive_refs=(base_closed, f6_closed),
        meta_window_hours=24,
    ))
    adapt_oos_net = sum(x[0] for x in adapt_oos_trades)

    return {
        "policy": best_policy,
        "train_net": best_train_net,
        "base_oos_net": base_oos_net,
        "adapt_oos_net": adapt_oos_net,
        "oos_trades": len(base_oos_trades),
    }

def main():
    interval = sys.argv[1] if len(sys.argv) > 1 else "Min15"
    mult = float(sys.argv[2]) if len(sys.argv) > 2 else bt.RANGE_ATR_MULT
    symbols = sys.argv[3:] if len(sys.argv) > 3 else bt.DEFAULT_BASKET

    print(f"OOS GRID VALIDATION | {len(symbols)} symbols | {interval} | "
          f"mult={mult} | split={SPLIT:.0%} train / {1-SPLIT:.0%} oos")
    print("=" * 88)
    print(f"{'symbol':12s} {'policy':>10s} {'train%':>9s} "
          f"{'base_oos%':>10s} {'adapt_oos%':>11s} {'adapt-base':>11s} {'n_oos':>6s}")
    print("-" * 88)

    rows = []
    for sym in symbols:
        try:
            r = run_symbol_oos(sym, interval, mult, TOTAL)
        except Exception as e:
            print(f"{sym:12s}  ERROR: {e}")
            continue
        if r is None:
            print(f"{sym:12s}  insufficient data")
            continue
        pol = f"{r['policy'][0]}/{r['policy'][1]}"
        delta = r["adapt_oos_net"] - r["base_oos_net"]
        rows.append(r)
        print(f"{sym:12s} {pol:>10s} {r['train_net']:9.2f} "
              f"{r['base_oos_net']:10.2f} {r['adapt_oos_net']:11.2f} "
              f"{delta:+11.2f} {r['oos_trades']:6d}")

    if not rows:
        print("\nNo results.")
        return

    n = len(rows)
    avg_train = sum(r["train_net"] for r in rows) / n
    avg_base_oos = sum(r["base_oos_net"] for r in rows) / n
    avg_adapt_oos = sum(r["adapt_oos_net"] for r in rows) / n
    base_pos = sum(1 for r in rows if r["base_oos_net"] > 0)
    adapt_pos = sum(1 for r in rows if r["adapt_oos_net"] > 0)
    adapt_beats = sum(1 for r in rows if r["adapt_oos_net"] > r["base_oos_net"])

    print("-" * 88)
    print(f"{'AVERAGE':12s} {'':>10s} {avg_train:9.2f} "
          f"{avg_base_oos:10.2f} {avg_adapt_oos:11.2f}")
    print()
    print("=" * 88)
    print("VERDICT (read the OOS columns, not train):")
    print(f"  base grid  positive OOS:  {base_pos}/{n} symbols   (avg {avg_base_oos:+.2f}%)")
    print(f"  adaptive   positive OOS:  {adapt_pos}/{n} symbols   (avg {avg_adapt_oos:+.2f}%)")
    print(f"  adaptive beats base OOS:  {adapt_beats}/{n} symbols")
    print()
    if avg_base_oos <= 0 and avg_adapt_oos <= 0:
        print("  → NEGATIVE OOS. In-sample sweep was overfit. Same lesson as funding.")
    elif avg_adapt_oos > 0 and adapt_beats >= n * 0.6:
        print("  → POSITIVE OOS and kill-switch adds value. This is a keeper — build on it.")
    else:
        print("  → THIN / mixed OOS. Real but fee-fragile; run small, expect little.")
    print("=" * 88)

if __name__ == "__main__":
    main()

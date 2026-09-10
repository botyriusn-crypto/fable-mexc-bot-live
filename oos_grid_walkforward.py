#!/usr/bin/env python3
# oos_grid_walkforward.py — rolling walk-forward validation for the grid backtest.
# For each symbol: slide a (train -> oos) window across history. On every fold,
# select the hold policy on TRAIN, measure PnL on the following OOS segment.
# A single lucky split can't survive this; a real edge stays positive across folds.
#
# Usage: python3 oos_grid_walkforward.py [interval] [mult] [SYM ...]

import sys
import backtest_maxhold as bt

TOTAL       = 8640   # candles to fetch (~90d Min15)
TRAIN_FRAC  = 0.35   # each fold trains on 35% of TOTAL ...
OOS_FRAC    = 0.15   # ... then tests on the next 15% (unseen)
STEP_FRAC   = 0.15   # slide the window forward by 15% each fold

def walk_symbol(symbol, interval, mult, total):
    candles = bt.fetch_klines(symbol, interval, total)
    min_seg = bt.ADX_PERIOD * 2 + 2
    if candles is None or len(candles) < min_seg * 3:
        return None
    n = len(candles)
    train_len = int(n * TRAIN_FRAC)
    oos_len   = int(n * OOS_FRAC)
    step      = max(1, int(n * STEP_FRAC))
    if train_len < min_seg or oos_len < min_seg:
        return None

    folds = []
    start = 0
    while start + train_len + oos_len <= n:
        train = candles[start : start + train_len]
        oos   = candles[start + train_len : start + train_len + oos_len]

        # select hold policy on TRAIN only
        best_policy, best_net = None, float("-inf")
        for hr, ht in bt.HOLD_POLICIES:
            t = bt.apply_fees(bt.simulate(train, hr, ht, mult, "none"))
            net = sum(x[0] for x in t)
            if net > best_net:
                best_net, best_policy = net, (hr, ht)
        hr, ht = best_policy

        # measure frozen policy on OOS: base + adaptive kill-switch
        base = bt.apply_fees(bt.simulate(oos, hr, ht, mult, "none"))
        base_net = sum(x[0] for x in base)
        _, base_closed = bt.simulate(oos, hr, ht, mult, "none", return_closed=True)
        _, f6_closed   = bt.simulate(oos, hr, ht, mult, "none",
                                     flow_window_hours=6, return_closed=True)
        adapt = bt.apply_fees(bt.simulate(
            oos, hr, ht, mult, "none",
            flow_window_hours=6, adaptive_refs=(base_closed, f6_closed),
            meta_window_hours=24))
        adapt_net = sum(x[0] for x in adapt)

        folds.append({
            "policy": best_policy,
            "base_oos": base_net,
            "adapt_oos": adapt_net,
            "n_oos": len(base),
        })
        start += step

    if not folds:
        return None
    return folds

def main():
    interval = sys.argv[1] if len(sys.argv) > 1 else "Min15"
    mult = float(sys.argv[2]) if len(sys.argv) > 2 else bt.RANGE_ATR_MULT
    symbols = sys.argv[3:] if len(sys.argv) > 3 else bt.DEFAULT_BASKET

    print(f"WALK-FORWARD GRID VALIDATION | {len(symbols)} symbols | {interval} | mult={mult}")
    print(f"train={TRAIN_FRAC:.0%}  oos={OOS_FRAC:.0%}  step={STEP_FRAC:.0%}")
    print("=" * 92)
    print(f"{'symbol':12s} {'folds':>5s} {'base+/n':>9s} {'adapt+/n':>9s} "
          f"{'base_mean':>10s} {'adapt_mean':>11s} {'base_worst':>11s}")
    print("-" * 92)

    agg = {"base_folds": 0, "base_pos": 0, "adapt_folds": 0, "adapt_pos": 0,
           "sym_base_pos": 0, "sym_adapt_pos": 0, "n_sym": 0}

    for sym in symbols:
        try:
            folds = walk_symbol(sym, interval, mult, TOTAL)
        except Exception as e:
            print(f"{sym:12s}  ERROR: {e}")
            continue
        if not folds:
            print(f"{sym:12s}  insufficient data")
            continue

        nf = len(folds)
        base_vals  = [f["base_oos"]  for f in folds]
        adapt_vals = [f["adapt_oos"] for f in folds]
        base_pos  = sum(1 for v in base_vals  if v > 0)
        adapt_pos = sum(1 for v in adapt_vals if v > 0)
        base_mean  = sum(base_vals)  / nf
        adapt_mean = sum(adapt_vals) / nf
        base_worst = min(base_vals)

        # "robust" = strategy positive in the MAJORITY of that symbol's folds
        sym_base_ok  = base_pos  >= (nf + 1) // 2
        sym_adapt_ok = adapt_pos >= (nf + 1) // 2

        agg["base_folds"]  += nf; agg["base_pos"]  += base_pos
        agg["adapt_folds"] += nf; agg["adapt_pos"] += adapt_pos
        agg["sym_base_pos"]  += 1 if sym_base_ok  else 0
        agg["sym_adapt_pos"] += 1 if sym_adapt_ok else 0
        agg["n_sym"] += 1

        print(f"{sym:12s} {nf:5d} {base_pos:>4d}/{nf:<4d} {adapt_pos:>4d}/{nf:<4d} "
              f"{base_mean:10.2f} {adapt_mean:11.2f} {base_worst:11.2f}")

    if agg["n_sym"] == 0:
        print("\nNo results.")
        return

    print("-" * 92)
    print("=" * 92)
    bf, bp = agg["base_folds"], agg["base_pos"]
    af, ap = agg["adapt_folds"], agg["adapt_pos"]
    ns = agg["n_sym"]
    print("WALK-FORWARD VERDICT (robustness across regimes, not one lucky split):")
    print(f"  base  : {bp}/{bf} folds positive ({bp/bf:.0%})   |  "
          f"{agg['sym_base_pos']}/{ns} symbols robust")
    print(f"  adapt : {ap}/{af} folds positive ({ap/af:.0%})   |  "
          f"{agg['sym_adapt_pos']}/{ns} symbols robust")
    print()
    frac = ap / af
    if frac >= 0.70 and agg["sym_adapt_pos"] >= ns * 0.7:
        print("  → ROBUST across folds. Edge is not a single-split artifact. Proceed to paper.")
    elif frac >= 0.55:
        print("  → MODERATELY robust. Real but regime-sensitive. Paper small, watch trending periods.")
    else:
        print("  → FRAGILE. The single split flattered it. Do NOT scale; investigate which regimes fail.")
    print("=" * 92)

if __name__ == "__main__":
    main()

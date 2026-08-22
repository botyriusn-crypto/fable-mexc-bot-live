#!/usr/bin/env python3
# exit_sweep.py — upper-bound analysis of take-profit-at-X policies from sniper CSVs.
# If mfeR >= X: outcome = X - costR (costR est. from stop width; RT fee 0.04% + slip 0.06%)
# else: outcome = -1.13R (empirical full-SL loser incl. costs)
# UPPER BOUND (same-bar ambiguity unresolved) -> failing here = definitively dead.
import csv, glob

files = []
for pat in ("sn_*.csv", "sn2_*.csv", "sno60_*.csv", "sno120_*.csv"):
    files += sorted(glob.glob(pat))

rows = []
for f in files:
    with open(f) as fh:
        for r in csv.DictReader(fh):
            if r.get("mfeR") is not None and r.get("stopPct"):
                rows.append(r)

print(f"Trades analyzed: {len(rows)}")
XS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0]
print(f"{'X':>6} | {'pooled avgR':>11} | {'sweep avgR':>10} | {'sigma avgR':>10} | {'P(touch)':>8}")
print("-" * 60)
for X in XS:
    tot = {"all": [], "sweep": [], "sigma": []}
    for r in rows:
        mfe = float(r["mfeR"]); sp = float(r["stopPct"])
        costR = 0.001 / (sp / 100.0)          # RT fee+slip as fraction of stop distance
        out = (X - costR) if mfe >= X else -1.13
        tot["all"].append(out)
        if r.get("signalType") in tot: tot[r["signalType"]].append(out)
    avg = lambda L: sum(L) / len(L) if L else float("nan")
    touch = sum(1 for r in rows if float(r["mfeR"]) >= X) / len(rows)
    print(f"{X:>5}R | {avg(tot['all']):>+11.3f} | {avg(tot['sweep']):>+10.3f} | {avg(tot['sigma']):>+10.3f} | {touch:>7.1%}")
print("\nX=3.0 row should roughly match the measured -0.153R pooled (sanity check).")

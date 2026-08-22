#!/usr/bin/env python3
# agg_sniper.py — aggregate sniper per-trade CSVs (deduped) by signal type + exit reason.
import csv, glob, sys

patterns = sys.argv[1:] or ["sn_*.csv"]
files = []
for p in patterns:
    files += sorted(glob.glob(p))

rows = {}
for f in files:
    base = f.split("/")[-1].upper()
    for pre in ("SNBEO60_", "SNO120_", "SNBE_", "SNO60_", "SN2_", "SN_"):
        if base.startswith(pre):
            base = base[len(pre):]
            break
    if base.endswith(".CSV"):
        base = base[:-4]
    sym = base if base.endswith("_USDT") else base + "_USDT"
    try:
        with open(f) as fh:
            for r in csv.DictReader(fh):
                if not r.get("pnl"):
                    continue
                r["sym"] = sym
                rows[(sym, r.get("side"), r.get("entryTime"), r.get("signalType"))] = r
    except FileNotFoundError:
        print(f"  (missing: {f})")

trades = list(rows.values())
print(f"Files: {len(files)}   Trades (deduped): {len(trades)}")
if not trades:
    sys.exit(0)

def show(items, label):
    n = len(items)
    if n == 0:
        return
    wins = sum(1 for r in items if float(r["pnl"]) > 0)
    tot = sum(float(r["pnl"]) for r in items)
    avgr = sum(float(r["r"]) for r in items) / n
    print(f"  {label:10} n={n:5}  win={wins / n * 100:5.1f}%  pnl={tot:11.2f}  avgR={avgr:+.3f}")

show(trades, "ALL")
for st in sorted({t.get("signalType", "?") for t in trades}):
    show([t for t in trades if t.get("signalType", "?") == st], st)
print("\n  exit reasons:")
for rs in sorted({t.get("reason", "?") for t in trades}):
    show([t for t in trades if t.get("reason", "?") == rs], rs)
print("\n  sigma per symbol:")
for sym in sorted({t["sym"] for t in trades}):
    ts = [t for t in trades if t["sym"] == sym and t.get("signalType") == "sigma"]
    if ts:
        n = len(ts)
        wins = sum(1 for r in ts if float(r["pnl"]) > 0)
        avgr = sum(float(r["r"]) for r in ts) / n
        print(f"    {sym:12} n={n:3}  win={wins / n * 100:5.1f}%  avgR={avgr:+.2f}")

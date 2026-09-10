#!/usr/bin/env python3
# paper_reconcile.py — paper-vs-backtest reconciliation for the grid strategy.
#
# Compares backtest-modeled fills against actual paper fills over the SAME
# window, and splits the gap into:
#   (a) fee-assumption drag  (backtest assumes TP maker=0 / exit taker=0.0002,
#       live Bybit fallback is maker=0.0002 both legs / taker=0.00055), and
#   (b) fill/slippage drag   (everything left over: missed maker fills,
#       adverse selection, timing differences).
#
# Paper CSV export (from Postgres):
#   SELECT symbol, entry_price, exit_price, size_usdt, pnl, fees,
#          exit_reason, closed_at
#   FROM trades WHERE strategy='grid' AND live=false
#     AND closed_at >= now() - interval '7 days'
#   ORDER BY closed_at;
# Save as paper_trades.csv (header row required).
#
# Usage:
#   python3 paper_reconcile.py --self-test            # no network, checks math
#   python3 paper_reconcile.py --symbol ENA_USDT --csv paper_trades.csv
#   python3 paper_reconcile.py --symbol ENA_USDT --csv paper_trades.csv \
#       --holds 720,180 --mult 0.5 --interval Min15 --total 2880
"""Reconcile paper fills vs backtest-modeled fills for the grid strategy."""
import argparse
import csv
import sys

# Live Bybit fallback rates from lib/exchange.ts (getFeeRates).
LIVE_MAKER = 0.0002
LIVE_TAKER = 0.00055


def live_fee_pct(reason):
    """Live fee in % of notional: TP pays maker on BOTH legs, exits pay taker."""
    if reason == "tp":
        return 2 * LIVE_MAKER * 100
    return LIVE_TAKER * 100


def paper_rows(path, symbol=None):
    """Load paper trades CSV. Returns list of dicts with ret_pct computed."""
    rows = []
    with open(path, newline="") as f:
        rdr = csv.DictReader(f)
        need = {"entry_price", "exit_price", "size_usdt", "pnl", "fees",
                "exit_reason"}
        missing = need - set(rdr.fieldnames or [])
        if missing:
            raise ValueError("CSV missing columns: %s (got %s)"
                             % (sorted(missing), rdr.fieldnames))
        for r in rdr:
            if symbol and r.get("symbol") and r["symbol"] != symbol:
                continue
            try:
                size = float(r["size_usdt"])
                pnl = float(r["pnl"])
            except (TypeError, ValueError):
                continue
            if size <= 0:
                continue
            rows.append({
                "reason": (r["exit_reason"] or "").strip() or "unknown",
                "ret_pct": pnl / size * 100,
                "pnl": pnl,
            })
    return rows


def summarize_pct(items):
    """items: list of (pct, reason). Returns (net, avg, by_reason dict)."""
    by = {}
    for pct, reason in items:
        by.setdefault(reason, []).append(pct)
    net = sum(p for p, _ in items)
    avg = net / len(items) if items else 0.0
    return net, avg, {k: (sum(v), sum(v) / len(v), len(v))
                     for k, v in by.items()}


def self_test():
    """Offline check of the reconciliation math with synthetic fills."""
    # 3 modeled TPs at +0.10% gross each, 1 stop at -4.00% gross.
    gross = [(0.10, "tp"), (0.10, "tp"), (0.10, "tp"), (-4.00, "stop-loss")]
    bt_net = sum(p - (0.0 if r == "tp" else 0.02) for p, r in gross)
    live_net = sum(p - live_fee_pct(r) for p, r in gross)
    assert abs(bt_net - (0.30 - 4.02)) < 1e-9, bt_net
    assert abs(live_net - (0.30 - 3 * 0.04 - 4.055)) < 1e-9, live_net
    fee_gap = live_net - bt_net
    assert fee_gap < 0, fee_gap
    # Paper rows: pnl/size*100 conversion.
    import tempfile, os
    with tempfile.NamedTemporaryFile("w", suffix=".csv",
                                     delete=False) as f:
        f.write("symbol,entry_price,exit_price,size_usdt,pnl,fees,"
                "exit_reason,closed_at\n")
        f.write("ENA_USDT,1.0,1.001,1000,1.0,0.4,tp,2026-09-01T00:00:00Z\n")
        name = f.name
    rows = paper_rows(name, symbol="ENA_USDT")
    os.unlink(name)
    assert len(rows) == 1 and abs(rows[0]["ret_pct"] - 0.10) < 1e-9, rows
    print("self-test OK: fee-gap=%.4f%% paper-ret=%.4f%%"
          % (fee_gap, rows[0]["ret_pct"]))


def main():
    ap = argparse.ArgumentParser(
        description="Reconcile paper fills vs backtest-modeled grid fills.")
    ap.add_argument("--symbol", default="ENA_USDT")
    ap.add_argument("--interval", default="Min15")
    ap.add_argument("--total", type=int, default=2880)
    ap.add_argument("--mult", type=float, default=None)
    ap.add_argument("--holds", default="720,180",
                    help="frozen hold policy RANGE,TREND minutes")
    ap.add_argument("--csv", default="paper_trades.csv",
                    help="paper trades CSV export")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()

    if a.self_test:
        self_test()
        return

    import backtest_maxhold as bt
    mult = a.mult if a.mult is not None else bt.RANGE_ATR_MULT
    hr, ht = (int(x) for x in a.holds.split(","))

    candles = bt.fetch_klines(a.symbol, a.interval, a.total)
    if not candles or len(candles) < bt.ADX_PERIOD * 2 + 2:
        print("insufficient candle data for %s" % a.symbol)
        sys.exit(2)
    t0 = candles[0]["time"]

    gross = bt.simulate(candles, hr, ht, mult, "none")  # gross pnl%
    bt_net = sum(bt.apply_fees(gross)[i][0] for i in range(len(gross)))
    live_net = sum(p - live_fee_pct(r) for p, r, _ in gross)
    _, _, by = summarize_pct([(p, r) for p, r, _ in gross])
    n = len(gross)

    try:
        paper = paper_rows(a.csv, symbol=a.symbol)
    except FileNotFoundError:
        print("CSV not found: %s\nExport it with:\n"
              "  SELECT symbol, entry_price, exit_price, size_usdt, pnl,\n"
              "         fees, exit_reason, closed_at FROM trades\n"
              "  WHERE strategy='grid' AND live=false\n"
              "    AND closed_at >= to_timestamp(%d)\n"
              "  ORDER BY closed_at;" % (a.csv, t0))
        print("\nModeled baseline for %s %s holds=%d/%d (no paper data):"
              % (a.symbol, a.interval, hr, ht))
        print("  gross-net %+.2f | backtest-fee net %+.2f | live-fee net "
              "%+.2f over %d modeled trades"
              % (sum(p for p, _, _ in gross), bt_net, live_net, n))
        sys.exit(1)

    p_net = sum(r["ret_pct"] for r in paper)
    p_avg = p_net / len(paper) if paper else 0.0
    fee_gap = live_net - bt_net
    fill_drag = p_net - live_net  # paper vs live-fee model, same units (%)

    print("RECONCILE %s %s holds=%d/%d mult=%s window_from=%d"
          % (a.symbol, a.interval, hr, ht, mult, t0))
    print("=" * 76)
    print("modeled trades: %d | paper trades: %d" % (n, len(paper)))
    print("modeled net (backtest fees): %+.2f%%  avg %+.4f%%/trade"
          % (bt_net, bt_net / n if n else 0))
    print("modeled net (live Bybit fees): %+.2f%%  avg %+.4f%%/trade"
          % (live_net, live_net / n if n else 0))
    print("paper net: %+.2f%%  avg %+.4f%%/trade"
          % (p_net, p_avg))
    print("-" * 76)
    print("fee-assumption drag (live-fee model minus backtest-fee model): "
          "%+.2f%%" % fee_gap)
    print("fill/slippage drag (paper minus live-fee model): %+.2f%% total, "
          "%+.4f%%/trade" % (fill_drag,
                             fill_drag / len(paper) if paper else 0))
    print()
    if paper and abs(fill_drag / len(paper)) < 0.02:
        print("-> fills track the model. Slippage is within maker noise.")
    elif paper and abs(fill_drag / len(paper)) < 0.06:
        print("-> normal maker slippage. Shave ~%.3f%%/trade off every "
              "backtest number." % abs(fill_drag / len(paper)))
    elif paper:
        print("-> LARGE drag: investigate missed fills / thin-pair "
              "adverse selection before any live size.")
    print("=" * 76)


if __name__ == "__main__":
    main()

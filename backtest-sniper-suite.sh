#!/bin/bash
# Sniper tuning suite — volatile alt universe only (majors excluded: no dislocations)

SYMBOLS=("WLD_USDT" "TAO_USDT" "HYPE_USDT" "LINK_USDT" "AVAX_USDT" "SUI_USDT" "PEPE_USDT" "DOGE_USDT" "SEI_USDT" "ORDI_USDT" "BASED_USDT" "ZEN_USDT")

# The questions we're answering:
#  current   = production (min-stop 0.8, TP 3R)          <- baseline
#  ms05/ms12 = is 0.8% the right floor?
#  tp2/tp4   = is 3R the right target?
#  be1       = does moving stop to BE at 1R help?
#  sig4      = is sigma 3.5 too loose?
CONFIGS=(
  "current:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 0.8"
  "ms05:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 0.5"
  "ms12:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 1.2"
  "tp2:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 0.8 --tp-ratio 2.0"
  "tp4:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 0.8 --tp-ratio 4.0"
  "be1:--sigma 3.5 --vol-mult 2.0 --min-stop-pct 0.8 --be-at 1.0"
  "sig4:--sigma 4.0 --vol-mult 2.0 --min-stop-pct 0.8"
)

CSV="sniper_suite_results.csv"
echo "symbol,config,trades,win_rate,avg_r,total_pnl,fees" > "$CSV"

for symbol in "${SYMBOLS[@]}"; do
  for cfg in "${CONFIGS[@]}"; do
    name="${cfg%%:*}"; params="${cfg#*:}"
    echo -n "  $symbol / $name ... "
    out=$(npx tsx backtest-sniper.ts --symbol "$symbol" --timeframe Min5 --days 60 --leverage 3 --risk-pct 0.01 $params 2>/dev/null)
    tr=$(echo "$out" | grep -oP 'Trades:\s+\K\d+' | head -1)
    wr=$(echo "$out" | grep -oP 'Win rate:\s+\K[0-9.]+' | head -1)
    ar=$(echo "$out" | grep -oP 'Avg R:\s+\K-?[0-9.]+' | head -1)
    pn=$(echo "$out" | grep -oP 'Total PnL:\s+\K-?[0-9.]+' | head -1)
    fe=$(echo "$out" | grep -oP 'Total fees:\s+\K[0-9.]+' | head -1)
    tr=${tr:-0}; wr=${wr:-0}; ar=${ar:-0}; pn=${pn:-0}; fe=${fe:-0}
    echo "$symbol,$name,$tr,$wr,$ar,$pn,$fe" >> "$CSV"
    echo "trades=$tr wr=$wr% R=$ar pnl=$pn"
  done
done

echo ""
echo "================ CONFIG RANKING (sum across all symbols) ================"
tail -n +2 "$CSV" | awk -F',' '
{
  t[$2]+=$3; w[$2]+=$3*$4; r[$2]+=$3*$5; p[$2]+=$6; f[$2]+=$7; s[$2]++
}
END {
  printf "%-9s %6s %8s %8s %10s %8s\n","config","trades","win%","avgR","totalPnL","fees"
  for (k in t) printf "%-9s %6d %7.1f%% %8.2f %10.1f %8.1f\n", k, t[k], (t[k]?w[k]/t[k]:0), (t[k]?r[k]/t[k]:0), p[k], f[k]
}' | sort -k5 -nr

echo ""
echo "================ PER-SYMBOL (current config) ================"
grep ",current," "$CSV" | awk -F',' '{printf "%-12s trades=%3d  wr=%5.1f%%  avgR=%6.2f  pnl=%9.1f\n",$1,$3,$4,$5,$6}' | sort -k5 -nr

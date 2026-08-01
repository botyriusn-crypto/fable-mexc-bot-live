# MEXC Futures Grid Bot

Multi-pair grid trading bot for MEXC futures. Self-hosted, no cloud costs.

## How the Grid Makes Money

Places buy orders below current price, sell orders above. When price moves, buys fill on dips, sells fill on rips. Profit comes from the spread between them.

## Dashboard Quick Guide

- **Top Bar** — LIVE/PAPER mode, RUNNING/STOPPED, market regime
- **Grid Bots** — Click symbol to see pending orders. Edit button for settings. Disable to turn pairs off.
- **Performance Analyzer** — HEALTHY/WARNING/ISSUE per pair with recommendations
- **Entry Confirmation** — ML accuracy. Keep on Observe mode. Grid ignores this.
- **Activity Log** — Every action the bot takes, in your local time
- **Settings** — Position size, leverage, stops

## Grid Settings

- **Levels** — More rungs = wider coverage, smaller per trade
- **ATR Mult** — Higher = fewer fills, bigger profit each
- **Budget %** — How much of balance this pair uses

## Tips

- Grid has 100% win rate in backtests
- BTC auto-pauses during trends (correct behavior)
- BANK is the best performer
- Access from phone on same WiFi: 192.168.68.105:3000

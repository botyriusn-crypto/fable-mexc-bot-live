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

## Authentication (IMPORTANT)

The dashboard and **all** API routes are protected by `middleware.ts`. Before
deploying, set these secrets (e.g. `fly secrets set NAME=value`):

- `DASHBOARD_PASSWORD` — password for the `/login` screen.
- `AUTH_SECRET` — signs session cookies (`openssl rand -hex 32`). Falls back to
  `DASHBOARD_PASSWORD` if unset.
- `API_KEY` — for programmatic/automation access. Send it as
  `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`.
- `WEBHOOK_PASSWORD` — for `/api/bot/webhook` (TradingView alerts).

How access works:
- **Browser** → log in at `/login`; an httpOnly session cookie (12 h) is set and
  the dashboard works normally.
- **Scripts / automation** → send the `API_KEY` header on each request.
- **Webhook** → `/api/bot/webhook` keeps its own shared-password auth.

If `DASHBOARD_PASSWORD` is not set the dashboard cannot be logged into, and if
`API_KEY` is not set programmatic header auth is disabled — both fail closed.

See `.env.example` for the full list of variables.

## Tips

- Grid has 100% win rate in backtests
- BTC auto-pauses during trends (correct behavior)
- BANK is the best performer
- Access from phone on same WiFi: 192.168.68.105:3000

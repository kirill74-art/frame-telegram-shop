# SIGNAL AI

Telegram Mini App for market analysis based on Pocket Option price data.

## Project direction

- Telegram bot + Mini App
- UP / DOWN analysis with a transparent indicator-based strategy
- Pocket Option OTC and regular instruments, subject to the data provider's available catalogue
- Signal history and measured outcomes
- No automatic trading and no Pocket Option account credentials

## Data source

Pocket Option does not publish an official public developer API. The project is designed to use a separate read-only market-data provider (OTCharts) through a server-side API key. The key must be stored in Render environment variables and must never be placed in browser code.

## Environment

- `BOT_TOKEN` — Telegram bot token
- `DATABASE_URL` — PostgreSQL connection string
- `MINI_APP_URL` — public HTTPS URL of the Mini App
- `OTCHARTS_API_KEY` — optional read-only market-data API key

## Important

Signals are analytical estimates, not guarantees of a profitable trade. The app must show “No signal” when data is missing, stale, or the strategy conditions are not met. It does not place trades or access a Pocket Option account.

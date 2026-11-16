# PerpScope

PerpScope is a Binance USDⓈ-M perpetual futures market scanner. It uses public Binance market endpoints and Supabase. It does not place orders, access private exchange accounts, or perform withdrawals.

## Project layout

- `index.html` — static Vercel dashboard.
- `supabase/functions/scan-binance-perpetuals/index.ts` — Supabase Edge Function scanner, signal generation, and paper-trade outcome tracking.
- `supabase/migrations/202611160001_complete_paper_trade_cycles.sql` — database schema, read-only dashboard policies, and 100-completed-trade cycle logic.

## Paper-trade rules

- Only generated LONG/SHORT candidates with valid entry, stop-loss, and take-profit are recorded.
- WATCH candidates are excluded.
- Trade records are simulated only; no exchange orders are submitted.
- The scanner evaluates closed Binance 1-minute candles every scheduled scan.
- If TP and SL are both touched in the same 1-minute candle, the result is conservatively recorded as LOSS (`BOTH_HIT_SAME_CANDLE`).
- Each cycle is archived after 100 generated LONG/SHORT paper-trade signals. Results from trades in archived cycles continue to update as they close. Historical cycles and trade records are retained.

## Deploy

Deploy the Edge Function from `supabase/functions/scan-binance-perpetuals` to Supabase project `dbxfrvqykuptohwimdor` with JWT verification enabled. The function requires the existing server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets; never place the service-role key in `index.html`.

Deploy `index.html` as the static production page for the existing Vercel project `perpscope`.

The database migration is already applied to the connected Supabase project. Keep this SQL file in source control so the schema change is documented and reproducible in another environment.
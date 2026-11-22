-- V1 scanner query indexes. Non-destructive; existing paper-trade rows are preserved.
create index if not exists paper_trades_status_last_checked_idx
  on public.paper_trades (status, last_checked_at);

create index if not exists paper_trades_scan_id_idx
  on public.paper_trades (scan_id);

create index if not exists trade_candidates_scan_side_idx
  on public.trade_candidates (scan_id, side);

create index if not exists market_analysis_scan_score_idx
  on public.market_analysis (scan_id, signal_score desc);

create index if not exists scan_runs_status_started_idx
  on public.scan_runs (status, started_at desc);

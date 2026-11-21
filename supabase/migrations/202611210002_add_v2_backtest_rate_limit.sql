CREATE TABLE IF NOT EXISTS public.v2_backtest_rate_limits (bucket_start timestamptz primary key, created_at timestamptz not null default now());
ALTER TABLE public.v2_backtest_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.v2_backtest_rate_limits FROM anon,authenticated;
GRANT ALL ON public.v2_backtest_rate_limits TO service_role;
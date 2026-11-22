-- V1 controlled trade-learning dataset and read-only performance rollups.
-- Captures immutable entry-time features and updates only outcome fields at close.
create schema if not exists private;

create table if not exists public.trade_learning_snapshots (
  paper_trade_id uuid primary key references public.paper_trades(id) on delete cascade,
  source_candidate_id bigint,
  scan_id uuid,
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  setup_key text not null,
  timeframe text not null default '5m',
  market_regime text,
  score numeric,
  confidence_label text,
  entry_price numeric,
  stop_loss numeric,
  take_profit numeric,
  planned_risk_reward numeric,
  entry_features jsonb not null default '{}'::jsonb,
  setup_reasons jsonb not null default '[]'::jsonb,
  strategy_version text not null default 'v1_baseline_2r',
  signal_created_at timestamptz not null,
  outcome_status text not null default 'OPEN' check (outcome_status in ('OPEN','WIN','LOSS')),
  exit_price numeric,
  exit_at timestamptz,
  exit_reason text,
  realized_r numeric,
  simulated_pnl_usd numeric,
  duration_seconds bigint,
  captured_at timestamptz not null default now(),
  outcome_updated_at timestamptz
);

create index if not exists trade_learning_symbol_time_idx
  on public.trade_learning_snapshots (symbol, signal_created_at desc);
create index if not exists trade_learning_setup_time_idx
  on public.trade_learning_snapshots (setup_key, signal_created_at desc);
create index if not exists trade_learning_regime_idx
  on public.trade_learning_snapshots (market_regime, outcome_status);
create index if not exists trade_learning_status_time_idx
  on public.trade_learning_snapshots (outcome_status, signal_created_at desc);

alter table public.trade_learning_snapshots enable row level security;
drop policy if exists "Public can read trade learning summaries" on public.trade_learning_snapshots;
create policy "Public can read trade learning summaries"
  on public.trade_learning_snapshots for select to anon, authenticated using (true);
grant select on public.trade_learning_snapshots to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.trade_learning_snapshots from anon, authenticated;

create or replace function private.capture_v1_trade_learning()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  candidate_reasons jsonb := '[]'::jsonb;
  feature_row record;
  derived_setup text;
begin
  if tg_op = 'INSERT' then
    select coalesce(tc.reasons, '[]'::jsonb) as reasons,
           ma.timeframe_data, ma.trend_alignment, ma.orderbook_imbalance,
           ma.spread_bps, ma.open_interest_usd, ma.open_interest_change_pct,
           ma.taker_buy_sell_ratio, ma.data_quality, ma.signal_score,
           ms.funding_rate, ms.quote_volume, ms.open_interest,
           ms.long_short_ratio, ms.price_change_pct
      into feature_row
    from public.trade_candidates tc
    left join public.market_analysis ma
      on ma.scan_id = new.scan_id and ma.symbol = new.symbol
    left join public.market_snapshots ms
      on ms.scan_id = new.scan_id and ms.symbol = new.symbol
    where tc.id = new.source_candidate_id;

    candidate_reasons := coalesce(feature_row.reasons, '[]'::jsonb);
    derived_setup := case
      when candidate_reasons::text ilike '%pullback%' then 'trend_pullback'
      when candidate_reasons::text ilike '%momentum%' then 'trend_momentum'
      else lower(new.side) || '_trend_confirmation'
    end;

    insert into public.trade_learning_snapshots (
      paper_trade_id, source_candidate_id, scan_id, symbol, side,
      setup_key, timeframe, market_regime, score, confidence_label,
      entry_price, stop_loss, take_profit, planned_risk_reward,
      entry_features, setup_reasons, signal_created_at,
      outcome_status, exit_price, exit_at, exit_reason, realized_r,
      simulated_pnl_usd, duration_seconds, outcome_updated_at
    ) values (
      new.id, new.source_candidate_id, new.scan_id, new.symbol, new.side,
      derived_setup, '5m', feature_row.trend_alignment, new.score,
      new.confidence_label, new.entry_price, new.stop_loss, new.take_profit,
      new.risk_reward,
      jsonb_build_object(
        'timeframe_data', coalesce(feature_row.timeframe_data, '{}'::jsonb),
        'orderbook_imbalance', feature_row.orderbook_imbalance,
        'spread_bps', feature_row.spread_bps,
        'open_interest_usd', feature_row.open_interest_usd,
        'open_interest_change_pct', feature_row.open_interest_change_pct,
        'taker_buy_sell_ratio', feature_row.taker_buy_sell_ratio,
        'data_quality', feature_row.data_quality,
        'analysis_score', feature_row.signal_score,
        'funding_rate', feature_row.funding_rate,
        'quote_volume', feature_row.quote_volume,
        'open_interest', feature_row.open_interest,
        'long_short_ratio', feature_row.long_short_ratio,
        'price_change_pct', feature_row.price_change_pct
      ),
      candidate_reasons, new.signal_created_at,
      new.status, new.exit_price, new.exit_at, new.exit_reason,
      new.realized_r, new.simulated_pnl_usd, new.duration_seconds,
      case when new.status <> 'OPEN' then now() else null end
    )
    on conflict (paper_trade_id) do nothing;
    return new;
  end if;

  update public.trade_learning_snapshots
     set outcome_status = new.status,
         exit_price = new.exit_price,
         exit_at = new.exit_at,
         exit_reason = new.exit_reason,
         realized_r = new.realized_r,
         simulated_pnl_usd = new.simulated_pnl_usd,
         duration_seconds = new.duration_seconds,
         outcome_updated_at = case when new.status <> 'OPEN' then now() else null end
   where paper_trade_id = new.id;
  return new;
end;
$$;

revoke all on function private.capture_v1_trade_learning() from public, anon, authenticated;
drop trigger if exists trg_capture_v1_trade_learning on public.paper_trades;
create trigger trg_capture_v1_trade_learning
after insert or update of status, exit_price, exit_at, exit_reason, realized_r,
  simulated_pnl_usd, duration_seconds
on public.paper_trades
for each row execute function private.capture_v1_trade_learning();

-- Backfill existing paper trades using the features recorded at their original scan.
insert into public.trade_learning_snapshots (
  paper_trade_id, source_candidate_id, scan_id, symbol, side, setup_key,
  timeframe, market_regime, score, confidence_label, entry_price, stop_loss,
  take_profit, planned_risk_reward, entry_features, setup_reasons,
  signal_created_at, outcome_status, exit_price, exit_at, exit_reason,
  realized_r, simulated_pnl_usd, duration_seconds, outcome_updated_at
)
select
  pt.id, pt.source_candidate_id, pt.scan_id, pt.symbol, pt.side,
  case
    when coalesce(tc.reasons, '[]'::jsonb)::text ilike '%pullback%' then 'trend_pullback'
    when coalesce(tc.reasons, '[]'::jsonb)::text ilike '%momentum%' then 'trend_momentum'
    else lower(pt.side) || '_trend_confirmation'
  end,
  '5m', ma.trend_alignment, pt.score, pt.confidence_label,
  pt.entry_price, pt.stop_loss, pt.take_profit, pt.risk_reward,
  jsonb_build_object(
    'timeframe_data', coalesce(ma.timeframe_data, '{}'::jsonb),
    'orderbook_imbalance', ma.orderbook_imbalance,
    'spread_bps', ma.spread_bps,
    'open_interest_usd', ma.open_interest_usd,
    'open_interest_change_pct', ma.open_interest_change_pct,
    'taker_buy_sell_ratio', ma.taker_buy_sell_ratio,
    'data_quality', ma.data_quality,
    'analysis_score', ma.signal_score,
    'funding_rate', ms.funding_rate,
    'quote_volume', ms.quote_volume,
    'open_interest', ms.open_interest,
    'long_short_ratio', ms.long_short_ratio,
    'price_change_pct', ms.price_change_pct
  ),
  coalesce(tc.reasons, '[]'::jsonb), pt.signal_created_at,
  pt.status, pt.exit_price, pt.exit_at, pt.exit_reason,
  pt.realized_r, pt.simulated_pnl_usd, pt.duration_seconds,
  case when pt.status <> 'OPEN' then coalesce(pt.exit_at, pt.updated_at) else null end
from public.paper_trades pt
left join public.trade_candidates tc on tc.id = pt.source_candidate_id
left join public.market_analysis ma on ma.scan_id = pt.scan_id and ma.symbol = pt.symbol
left join public.market_snapshots ms on ms.scan_id = pt.scan_id and ms.symbol = pt.symbol
on conflict (paper_trade_id) do nothing;

create or replace view public.trade_learning_performance
with (security_invoker = true)
as
select
  case
    when grouping(setup_key) = 0 then 'setup'
    when grouping(symbol) = 0 then 'symbol'
    when grouping(timeframe) = 0 then 'timeframe'
    else 'market_regime'
  end as dimension,
  coalesce(setup_key, symbol, timeframe, market_regime, 'unknown') as dimension_value,
  count(*)::bigint as completed_trades,
  count(*) filter (where outcome_status = 'WIN')::bigint as wins,
  count(*) filter (where outcome_status = 'LOSS')::bigint as losses,
  round(100.0 * count(*) filter (where outcome_status = 'WIN') / nullif(count(*),0), 2) as win_rate_pct,
  round(avg(realized_r), 4) as average_realized_r,
  round(sum(realized_r), 4) as net_realized_r,
  round(sum(simulated_pnl_usd), 2) as gross_simulated_pnl_usd,
  round(avg(duration_seconds))::bigint as average_duration_seconds,
  round(
    sum(realized_r) filter (where realized_r > 0)
    / nullif(abs(sum(realized_r) filter (where realized_r < 0)), 0), 4
  ) as profit_factor
from public.trade_learning_snapshots
where outcome_status in ('WIN','LOSS') and realized_r is not null
group by grouping sets ((setup_key), (symbol), (timeframe), (market_regime));

grant select on public.trade_learning_performance to anon, authenticated;

create table if not exists public.strategy_experiments (
  id uuid primary key default gen_random_uuid(),
  experiment_name text not null,
  hypothesis text not null,
  base_strategy_version text not null default 'v1_baseline_2r',
  candidate_parameters jsonb not null default '{}'::jsonb,
  train_period tstzrange,
  validation_period tstzrange,
  holdout_period tstzrange,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed','running','passed','rejected','archived')),
  acceptance_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);
alter table public.strategy_experiments enable row level security;
revoke all on public.strategy_experiments from anon, authenticated;

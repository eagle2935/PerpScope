-- PerpScope V1 controlled feedback engine.
-- Entry features are frozen at signal creation; outcomes are attached at close.
-- This migration does not change scanner entry/exit rules or enable real orders.

create table if not exists public.trade_learning_snapshots (
  paper_trade_id uuid primary key references public.paper_trades(id) on delete cascade,
  source_candidate_id bigint,
  scan_id uuid,
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  setup_key text not null,
  trigger_timeframe text not null default '5m',
  trend_regime text,
  volatility_regime text,
  orderflow_regime text,
  score numeric,
  score_bucket text,
  confidence_label text,
  entry_price numeric,
  stop_loss numeric,
  take_profit numeric,
  planned_risk_reward numeric,
  atr15_pct numeric,
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
  on public.trade_learning_snapshots (trend_regime, volatility_regime, orderflow_regime);
create index if not exists trade_learning_status_time_idx
  on public.trade_learning_snapshots (outcome_status, signal_created_at desc);

alter table public.trade_learning_snapshots enable row level security;
drop policy if exists "Public can read trade learning summaries" on public.trade_learning_snapshots;
create policy "Public can read trade learning snapshots"
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
  feature_row record;
  reasons jsonb := '[]'::jsonb;
  setup_name text;
  atr_pct numeric;
  expected_trend text;
  ob numeric;
  taker numeric;
  regime_orderflow text;
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

    reasons := coalesce(feature_row.reasons, '[]'::jsonb);
    setup_name := case
      when reasons::text ilike '%pullback%' and reasons::text ilike '%momentum%' then 'mtf_pullback_momentum'
      when reasons::text ilike '%pullback%' then 'pullback'
      when reasons::text ilike '%momentum%' then 'momentum'
      else 'other'
    end;
    atr_pct := case
      when nullif(feature_row.timeframe_data->'15m'->>'atr14','') is not null
       and nullif(feature_row.timeframe_data->'15m'->>'close','') is not null
       and (feature_row.timeframe_data->'15m'->>'close')::numeric > 0
      then 100 * (feature_row.timeframe_data->'15m'->>'atr14')::numeric
                / (feature_row.timeframe_data->'15m'->>'close')::numeric
      else null end;
    expected_trend := case when new.side = 'LONG' then 'BULLISH' else 'BEARISH' end;
    ob := nullif(feature_row.orderbook_imbalance::text,'')::numeric;
    taker := nullif(feature_row.taker_buy_sell_ratio::text,'')::numeric;
    regime_orderflow := case
      when ob is null or taker is null then 'unknown'
      when new.side='LONG' and ob > 0 and taker > 1 then 'supportive'
      when new.side='SHORT' and ob < 0 and taker < 1 then 'supportive'
      when new.side='LONG' and ob < 0 and taker < 1 then 'adverse'
      when new.side='SHORT' and ob > 0 and taker > 1 then 'adverse'
      else 'mixed'
    end;

    insert into public.trade_learning_snapshots (
      paper_trade_id, source_candidate_id, scan_id, symbol, side,
      setup_key, trigger_timeframe, trend_regime, volatility_regime,
      orderflow_regime, score, score_bucket, confidence_label,
      entry_price, stop_loss, take_profit, planned_risk_reward, atr15_pct,
      entry_features, setup_reasons, signal_created_at,
      outcome_status, exit_price, exit_at, exit_reason, realized_r,
      simulated_pnl_usd, duration_seconds, outcome_updated_at
    ) values (
      new.id, new.source_candidate_id, new.scan_id, new.symbol, new.side,
      setup_name, '5m', feature_row.trend_alignment,
      case when atr_pct is null then 'unknown'
           when atr_pct < 0.5 then 'low'
           when atr_pct <= 1.5 then 'normal' else 'high' end,
      regime_orderflow, new.score,
      case when new.score < 60 then '<60'
           when new.score < 80 then '60-79'
           when new.score < 90 then '80-89' else '90+' end,
      new.confidence_label, new.entry_price, new.stop_loss, new.take_profit,
      new.risk_reward, atr_pct,
      jsonb_build_object(
        'timeframe_data', coalesce(feature_row.timeframe_data, '{}'::jsonb),
        'trend_alignment', feature_row.trend_alignment,
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
        'price_change_pct', feature_row.price_change_pct,
        'expected_trend', expected_trend
      ),
      reasons, new.signal_created_at,
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

-- Backfill historical paper trades using their original scan feature rows.
insert into public.trade_learning_snapshots (
  paper_trade_id, source_candidate_id, scan_id, symbol, side, setup_key,
  trigger_timeframe, trend_regime, volatility_regime, orderflow_regime,
  score, score_bucket, confidence_label, entry_price, stop_loss, take_profit,
  planned_risk_reward, atr15_pct, entry_features, setup_reasons,
  signal_created_at, outcome_status, exit_price, exit_at, exit_reason,
  realized_r, simulated_pnl_usd, duration_seconds, outcome_updated_at
)
select
  pt.id, pt.source_candidate_id, pt.scan_id, pt.symbol, pt.side,
  case
    when coalesce(tc.reasons, '[]'::jsonb)::text ilike '%pullback%'
     and coalesce(tc.reasons, '[]'::jsonb)::text ilike '%momentum%' then 'mtf_pullback_momentum'
    when coalesce(tc.reasons, '[]'::jsonb)::text ilike '%pullback%' then 'pullback'
    when coalesce(tc.reasons, '[]'::jsonb)::text ilike '%momentum%' then 'momentum'
    else 'other'
  end,
  '5m', ma.trend_alignment,
  case
    when ma.timeframe_data->'15m'->>'atr14' is null or ma.timeframe_data->'15m'->>'close' is null then 'unknown'
    when (ma.timeframe_data->'15m'->>'close')::numeric <= 0 then 'unknown'
    when 100*(ma.timeframe_data->'15m'->>'atr14')::numeric/(ma.timeframe_data->'15m'->>'close')::numeric < 0.5 then 'low'
    when 100*(ma.timeframe_data->'15m'->>'atr14')::numeric/(ma.timeframe_data->'15m'->>'close')::numeric <= 1.5 then 'normal'
    else 'high'
  end,
  case
    when ma.orderbook_imbalance is null or ma.taker_buy_sell_ratio is null then 'unknown'
    when pt.side='LONG' and ma.orderbook_imbalance>0 and ma.taker_buy_sell_ratio>1 then 'supportive'
    when pt.side='SHORT' and ma.orderbook_imbalance<0 and ma.taker_buy_sell_ratio<1 then 'supportive'
    when pt.side='LONG' and ma.orderbook_imbalance<0 and ma.taker_buy_sell_ratio<1 then 'adverse'
    when pt.side='SHORT' and ma.orderbook_imbalance>0 and ma.taker_buy_sell_ratio>1 then 'adverse'
    else 'mixed'
  end,
  pt.score,
  case when pt.score<60 then '<60' when pt.score<80 then '60-79' when pt.score<90 then '80-89' else '90+' end,
  pt.confidence_label, pt.entry_price, pt.stop_loss, pt.take_profit, pt.risk_reward,
  case when ma.timeframe_data->'15m'->>'atr14' is not null
         and ma.timeframe_data->'15m'->>'close' is not null
         and (ma.timeframe_data->'15m'->>'close')::numeric>0
       then 100*(ma.timeframe_data->'15m'->>'atr14')::numeric/(ma.timeframe_data->'15m'->>'close')::numeric
       else null end,
  jsonb_build_object(
    'timeframe_data',coalesce(ma.timeframe_data,'{}'::jsonb),
    'trend_alignment',ma.trend_alignment,
    'orderbook_imbalance',ma.orderbook_imbalance,
    'spread_bps',ma.spread_bps,
    'open_interest_usd',ma.open_interest_usd,
    'open_interest_change_pct',ma.open_interest_change_pct,
    'taker_buy_sell_ratio',ma.taker_buy_sell_ratio,
    'data_quality',ma.data_quality,
    'analysis_score',ma.signal_score,
    'funding_rate',ms.funding_rate,
    'quote_volume',ms.quote_volume,
    'open_interest',ms.open_interest,
    'long_short_ratio',ms.long_short_ratio,
    'price_change_pct',ms.price_change_pct,
    'expected_trend',case when pt.side='LONG' then 'BULLISH' else 'BEARISH' end
  ),
  coalesce(tc.reasons,'[]'::jsonb),pt.signal_created_at,pt.status,
  pt.exit_price,pt.exit_at,pt.exit_reason,pt.realized_r,pt.simulated_pnl_usd,
  pt.duration_seconds,case when pt.status<>'OPEN' then coalesce(pt.exit_at,pt.updated_at) else null end
from public.paper_trades pt
left join public.trade_candidates tc on tc.id=pt.source_candidate_id
left join public.market_analysis ma on ma.scan_id=pt.scan_id and ma.symbol=pt.symbol
left join public.market_snapshots ms on ms.scan_id=pt.scan_id and ms.symbol=pt.symbol
on conflict (paper_trade_id) do nothing;

create or replace view public.trade_learning_performance
with (security_invoker = true)
as
select
  case
    when grouping(setup_key)=0 then 'setup'
    when grouping(symbol)=0 then 'symbol'
    when grouping(trigger_timeframe)=0 then 'timeframe'
    when grouping(trend_regime)=0 then 'trend_regime'
    when grouping(volatility_regime)=0 then 'volatility_regime'
    when grouping(orderflow_regime)=0 then 'orderflow_regime'
    else 'score_bucket'
  end as dimension,
  coalesce(setup_key,symbol,trigger_timeframe,trend_regime,volatility_regime,orderflow_regime,score_bucket,'unknown') as dimension_value,
  count(*)::bigint as completed_trades,
  count(*) filter(where outcome_status='WIN')::bigint as wins,
  count(*) filter(where outcome_status='LOSS')::bigint as losses,
  round(100.0*count(*) filter(where outcome_status='WIN')/nullif(count(*),0),2) as win_rate_pct,
  round(avg(realized_r),4) as average_realized_r,
  round(sum(realized_r),4) as net_realized_r,
  round(sum(simulated_pnl_usd),2) as gross_simulated_pnl_usd,
  round(avg(duration_seconds))::bigint as average_duration_seconds,
  round(sum(realized_r) filter(where realized_r>0)/nullif(abs(sum(realized_r) filter(where realized_r<0)),0),4) as profit_factor
from public.trade_learning_snapshots
where outcome_status in ('WIN','LOSS') and realized_r is not null
group by grouping sets (
  (setup_key),(symbol),(trigger_timeframe),(trend_regime),
  (volatility_regime),(orderflow_regime),(score_bucket)
);

grant select on public.trade_learning_performance to anon, authenticated;

create table if not exists public.strategy_experiments (
  id uuid primary key default gen_random_uuid(),
  experiment_name text not null,
  hypothesis text not null,
  base_strategy_version text not null default 'v1_baseline_2r',
  candidate_parameters jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'proposed'
    check(status in ('proposed','running','passed','rejected','archived')),
  promotion_eligible boolean not null default false,
  auto_promoted boolean not null default false,
  acceptance_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.strategy_experiments enable row level security;
revoke all on public.strategy_experiments from public, anon, authenticated;

create table if not exists public.strategy_control (
  id boolean primary key default true check(id),
  active_strategy_version text not null default 'v1_baseline_2r',
  active_parameters jsonb not null default '{"risk_reward":2,"stop_atr_multiplier":1.5}'::jsonb,
  auto_promotion_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.strategy_control enable row level security;
revoke all on public.strategy_control from public, anon, authenticated;
insert into public.strategy_control(id) values(true) on conflict(id) do nothing;

-- Chronological filter replay on recorded trades. This evaluates entry filters only;
-- the original paper-trade exits remain unchanged. It is not a candle-level backtest.
create or replace function private.evaluate_v1_filter_experiment(
  p_experiment_name text,
  p_hypothesis text,
  p_max_spread_bps numeric default 2.0,
  p_min_oi_change_pct numeric default 0.1,
  p_min_orderbook_abs numeric default 0.0,
  p_require_taker_confirmation boolean default false
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  experiment_id uuid;
  result_metrics jsonb;
  pass_gate boolean := false;
  reason text;
begin
  insert into public.strategy_experiments(
    experiment_name,hypothesis,candidate_parameters,status
  ) values (
    p_experiment_name,p_hypothesis,
    jsonb_build_object(
      'max_spread_bps',p_max_spread_bps,
      'min_oi_change_pct',p_min_oi_change_pct,
      'min_orderbook_abs',p_min_orderbook_abs,
      'require_taker_confirmation',p_require_taker_confirmation,
      'evaluation_mode','chronological entry-filter replay; original exits unchanged'
    ),'running'
  ) returning id into experiment_id;

  with base as (
    select s.*,
      nullif(s.entry_features->>'spread_bps','')::numeric spread_bps,
      nullif(s.entry_features->>'open_interest_change_pct','')::numeric oi_change,
      nullif(s.entry_features->>'orderbook_imbalance','')::numeric ob_imbalance,
      nullif(s.entry_features->>'taker_buy_sell_ratio','')::numeric taker_ratio,
      ntile(5) over(order by s.signal_created_at,s.paper_trade_id) fold
    from public.trade_learning_snapshots s
    where s.outcome_status in ('WIN','LOSS') and s.realized_r is not null
  ),
  variants as (
    select 'baseline' variant,fold,outcome_status,realized_r from base
    union all
    select 'candidate',fold,outcome_status,realized_r from base
    where spread_bps is not null and spread_bps <= p_max_spread_bps
      and oi_change is not null and oi_change >= p_min_oi_change_pct
      and (p_min_orderbook_abs<=0 or
        (ob_imbalance is not null and
          case when side='LONG' then ob_imbalance>=p_min_orderbook_abs
               else ob_imbalance<=-p_min_orderbook_abs end))
      and (not p_require_taker_confirmation or
        (taker_ratio is not null and
          case when side='LONG' then taker_ratio>1 else taker_ratio<1 end))
  ),
  metrics as (
    select variant,
      case when fold<=3 then 'train_60' when fold=4 then 'validation_20' else 'holdout_20' end split,
      count(*)::int n,
      count(*) filter(where outcome_status='WIN')::int wins,
      round(100.0*count(*) filter(where outcome_status='WIN')/nullif(count(*),0),2) win_rate_pct,
      round(avg(realized_r),4) average_r,
      round(sum(realized_r),4) net_r,
      round(sum(realized_r) filter(where realized_r>0)/
        nullif(abs(sum(realized_r) filter(where realized_r<0)),0),4) profit_factor
    from variants group by variant,split
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'variant',variant,'split',split,'trades',n,'wins',wins,
    'win_rate_pct',win_rate_pct,'average_r',average_r,
    'net_r',net_r,'profit_factor',profit_factor
  ) order by variant,split),'[]'::jsonb)
  into result_metrics from metrics;

  with parsed as (
    select x->>'variant' variant,x->>'split' split,
      (x->>'trades')::int trades,
      nullif(x->>'average_r','')::numeric average_r,
      nullif(x->>'profit_factor','')::numeric profit_factor
    from jsonb_array_elements(result_metrics) x
  )
  select
    coalesce(max(average_r) filter(where variant='candidate' and split='train_60'),-999) > -999
    and coalesce(max(trades) filter(where variant='candidate' and split='train_60'),0)>=30
    and coalesce(max(trades) filter(where variant='candidate' and split='validation_20'),0)>=15
    and coalesce(max(trades) filter(where variant='candidate' and split='holdout_20'),0)>=15
    and coalesce(max(average_r) filter(where variant='candidate' and split='validation_20'),-999)
       > coalesce(max(average_r) filter(where variant='baseline' and split='validation_20'),999)
    and coalesce(max(average_r) filter(where variant='candidate' and split='holdout_20'),-999)
       > coalesce(max(average_r) filter(where variant='baseline' and split='holdout_20'),999)
    and coalesce(max(profit_factor) filter(where variant='candidate' and split='holdout_20'),0)
       > coalesce(max(profit_factor) filter(where variant='baseline' and split='holdout_20'),999)
  into pass_gate from parsed;

  reason := case when pass_gate
    then 'Candidate beat baseline on both validation and unseen chronological holdout with minimum sample sizes.'
    else 'Rejected or not yet eligible: candidate must have at least 30 train, 15 validation and 15 holdout trades and beat baseline average R on validation and holdout plus holdout profit factor.' end;

  update public.strategy_experiments
     set metrics=result_metrics,
         status=case when pass_gate then 'passed' else 'rejected' end,
         promotion_eligible=pass_gate,
         auto_promoted=false,
         acceptance_reason=reason,
         completed_at=now()
   where id=experiment_id;

  return experiment_id;
end;
$$;

revoke all on function private.evaluate_v1_filter_experiment(text,text,numeric,numeric,numeric,boolean)
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.evaluate_v1_filter_experiment(text,text,numeric,numeric,numeric,boolean)
  to service_role;

-- Public-schema wrapper is callable only with the server-side service_role key.
-- Never put that key in the browser.
create or replace function public.run_v1_filter_experiment(
  p_experiment_name text,
  p_hypothesis text,
  p_max_spread_bps numeric default 2.0,
  p_min_oi_change_pct numeric default 0.1,
  p_min_orderbook_abs numeric default 0.0,
  p_require_taker_confirmation boolean default false
) returns uuid
language sql
security invoker
set search_path = pg_catalog, public, private
as $
  select private.evaluate_v1_filter_experiment(
    p_experiment_name,p_hypothesis,p_max_spread_bps,
    p_min_oi_change_pct,p_min_orderbook_abs,p_require_taker_confirmation
  );
$;
revoke all on function public.run_v1_filter_experiment(text,text,numeric,numeric,numeric,boolean)
  from public, anon, authenticated;
grant execute on function public.run_v1_filter_experiment(text,text,numeric,numeric,numeric,boolean)
  to service_role;

create table if not exists public.paper_trade_cycles (
  cycle_number integer primary key,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  completed_count integer not null default 0 check (completed_count >= 0),
  win_count integer not null default 0 check (win_count >= 0),
  loss_count integer not null default 0 check (loss_count >= 0),
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table public.paper_trades add column if not exists cycle_trade_number integer;

create index if not exists paper_trades_open_symbol_idx on public.paper_trades (status, symbol, last_checked_at);
create index if not exists paper_trades_cycle_idx on public.paper_trades (cycle_number, created_at desc);
create index if not exists paper_trades_created_idx on public.paper_trades (created_at desc);

create or replace function public.assign_paper_trade_cycle()
returns trigger language plpgsql set search_path = '' as $$
declare v_cycle integer; v_trade_number integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('perpscope_paper_trade_cycle'));
  select cycle_number into v_cycle from public.paper_trade_cycles where status = 'ACTIVE' order by cycle_number desc limit 1 for update;
  if v_cycle is null then
    select coalesce(max(cycle_number), 0) + 1 into v_cycle from public.paper_trade_cycles;
    insert into public.paper_trade_cycles(cycle_number) values (v_cycle);
  end if;
  select count(*) + 1 into v_trade_number from public.paper_trades where cycle_number = v_cycle;
  new.cycle_number := v_cycle;
  new.cycle_trade_number := v_trade_number;
  return new;
end;
$$;

drop trigger if exists trg_assign_paper_trade_cycle on public.paper_trades;
create trigger trg_assign_paper_trade_cycle before insert on public.paper_trades for each row execute function public.assign_paper_trade_cycle();

create or replace function public.count_completed_paper_trade()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'OPEN' and new.status in ('WIN','LOSS') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('perpscope_paper_trade_cycle'));
    update public.paper_trade_cycles
    set completed_count = completed_count + 1,
        win_count = win_count + case when new.status = 'WIN' then 1 else 0 end,
        loss_count = loss_count + case when new.status = 'LOSS' then 1 else 0 end,
        status = case when completed_count + 1 >= 100 then 'CLOSED' else status end,
        closed_at = case when completed_count + 1 >= 100 then now() else closed_at end
    where cycle_number = new.cycle_number;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_count_completed_paper_trade on public.paper_trades;
create trigger trg_count_completed_paper_trade before update of status on public.paper_trades for each row execute function public.count_completed_paper_trade();

alter table public.paper_trade_cycles enable row level security;
alter table public.paper_trades enable row level security;
drop policy if exists "Public can read paper trade cycles" on public.paper_trade_cycles;
create policy "Public can read paper trade cycles" on public.paper_trade_cycles for select to anon, authenticated using (true);
revoke insert, update, delete, truncate, references, trigger on public.paper_trade_cycles from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.paper_trades from anon, authenticated;
grant select on public.paper_trade_cycles to anon, authenticated;
grant select on public.paper_trades to anon, authenticated;
grant all on public.paper_trade_cycles to service_role;
grant all on public.paper_trades to service_role;

-- Cycle boundary is 100 generated paper-trade signals, not 100 outcomes.
alter table public.paper_trade_cycles add column if not exists generated_count integer not null default 0 check (generated_count >= 0);
create or replace function public.assign_paper_trade_cycle()
returns trigger language plpgsql set search_path = '' as $$
declare v_cycle integer; v_trade_number integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('perpscope_paper_trade_cycle'));
  select cycle_number into v_cycle from public.paper_trade_cycles where status = 'ACTIVE' order by cycle_number desc limit 1 for update;
  if v_cycle is null then
    select coalesce(max(cycle_number), 0) + 1 into v_cycle from public.paper_trade_cycles;
    insert into public.paper_trade_cycles(cycle_number) values (v_cycle);
  end if;
  update public.paper_trade_cycles
  set generated_count = generated_count + 1,
      status = case when generated_count + 1 >= 100 then 'CLOSED' else status end,
      closed_at = case when generated_count + 1 >= 100 then now() else closed_at end
  where cycle_number = v_cycle returning generated_count into v_trade_number;
  new.cycle_number := v_cycle;
  new.cycle_trade_number := v_trade_number;
  return new;
end;
$$;
create or replace function public.count_completed_paper_trade()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'OPEN' and new.status in ('WIN','LOSS') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('perpscope_paper_trade_cycle'));
    update public.paper_trade_cycles
    set completed_count = completed_count + 1,
        win_count = win_count + case when new.status = 'WIN' then 1 else 0 end,
        loss_count = loss_count + case when new.status = 'LOSS' then 1 else 0 end
    where cycle_number = new.cycle_number;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace view public.paper_trade_performance_summary
with (security_invoker = true)
as
select
  count(*)::bigint as total_trades,
  count(*) filter (where status = 'OPEN')::bigint as open_trades,
  count(*) filter (where status in ('WIN','LOSS'))::bigint as completed_trades,
  count(*) filter (where status = 'WIN')::bigint as wins,
  count(*) filter (where status = 'LOSS')::bigint as losses,
  coalesce(sum(realized_r), 0)::numeric as net_realized_r,
  case when count(*) filter (where status in ('WIN','LOSS')) > 0
    then round(100.0 * count(*) filter (where status = 'WIN') /
      count(*) filter (where status in ('WIN','LOSS')), 2)
    else null end as win_rate
from public.paper_trades;
grant select on public.paper_trade_performance_summary to anon, authenticated;
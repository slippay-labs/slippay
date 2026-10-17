-- Durable Cross-Isolate Rate Limiting & pg_cron Sweep — Issue #191
--
-- Solves multi-isolate budget leakage on Supabase Edge Functions.
-- Ephemeral container restarts & horizontal scaling cannot reset token quotas.
-- Token bucket state is atomically stored in postgres with row-level locking.

create table if not exists public.rate_limit_buckets (
  id text primary key,
  tokens numeric(12, 4) not null,
  last_refill_ms bigint not null,
  updated_at timestamptz not null default now()
);

-- Index for maintenance & fast cleanup sweeps
create index if not exists idx_rate_limit_buckets_updated_at
  on public.rate_limit_buckets (updated_at);

-- Atomic conditional token consumption stored procedure
create or replace function public.consume_rate_limit_token(
  p_id text,
  p_capacity numeric,
  p_refill_per_sec numeric,
  p_now_ms bigint default (extract(epoch from clock_timestamp()) * 1000)::bigint
)
returns table (
  allowed boolean,
  tokens_remaining numeric,
  retry_after_sec integer
)
language plpgsql
security definer
as $$
declare
  v_bucket record;
  v_elapsed_sec numeric;
  v_tokens numeric;
  v_allowed boolean;
  v_retry_after integer;
begin
  -- Row-level exclusive lock prevents race condition across concurrent isolates
  select * into v_bucket
  from public.rate_limit_buckets
  where id = p_id
  for update;

  if not found then
    v_tokens := p_capacity;
  else
    v_elapsed_sec := greatest(0::numeric, (p_now_ms - v_bucket.last_refill_ms)::numeric / 1000.0);
    v_tokens := least(p_capacity, v_bucket.tokens + v_elapsed_sec * p_refill_per_sec);
  end if;

  if v_tokens >= 1.0 then
    v_tokens := v_tokens - 1.0;
    v_allowed := true;
    v_retry_after := 0;
  else
    v_allowed := false;
    v_retry_after := greatest(1, ceil((1.0 - v_tokens) / p_refill_per_sec)::integer);
  end if;

  insert into public.rate_limit_buckets (id, tokens, last_refill_ms, updated_at)
  values (p_id, v_tokens, p_now_ms, clock_timestamp())
  on conflict (id) do update
  set tokens = excluded.tokens,
      last_refill_ms = excluded.last_refill_ms,
      updated_at = excluded.updated_at;

  return query select v_allowed, v_tokens, v_retry_after;
end;
$$;

-- Periodic pg_cron cleanup for inactive rate limit buckets (idle > 2 days)
create extension if not exists pg_cron;

select cron.schedule(
  'slippay-cleanup-rate-limit-buckets',
  '0 */6 * * *',
  $$
    delete from public.rate_limit_buckets
    where updated_at < now() - interval '2 days';
  $$
);

-- Migration: backfill orders.platform_fee_bp, enforce NOT NULL, set default 297, and add CHECK constraint [0, 1000]
-- Fixes: slippay-labs/slippay#96, slippay-labs/slippay#229

-- 1. Ensure quarantine table exists for auditing orphan orders lacking a matching merchant
create table if not exists orders_quarantine (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  merchant_id uuid,
  reason text not null,
  quarantined_at timestamptz not null default now()
);

-- 2. Ensure marker column exists to record inferred fees
alter table orders
  add column if not exists fee_inferred boolean not null default false;

comment on column orders.fee_inferred is 'True if fee was inferred or defaulted by migration due to missing merchant/historical data';

-- 3. Backfill existing orders from merchant's platform_fee_bp, fallback to 297
update orders o
set platform_fee_bp = coalesce(m.platform_fee_bp, 297)
from merchants m
where o.merchant_id = m.id and o.platform_fee_bp is null;

-- 4. Audit & Quarantine orphan orders without matching merchant
do $$
declare
  orphan_count int;
begin
  select count(*) into orphan_count
  from orders o
  left join merchants m on o.merchant_id = m.id
  where m.id is null and o.platform_fee_bp is null;

  if orphan_count > 0 then
    insert into orders_quarantine (order_id, merchant_id, reason)
    select o.id, o.merchant_id, 'orphan_order_lacking_merchant_at_platform_fee_bp_migration'
    from orders o
    left join merchants m on o.merchant_id = m.id
    where m.id is null and o.platform_fee_bp is null;

    -- For technical NOT NULL compliance without destroying evidence,
    -- record default 297 marked explicitly with fee_inferred = true.
    update orders
    set platform_fee_bp = 297,
        fee_inferred = true
    where platform_fee_bp is null;

    raise notice 'Quarantined and marked % orphan orders in platform_fee_bp migration', orphan_count;
  end if;
end $$;

-- 5. Set default to 297 (canonical default platform fee, 2.97%)
alter table orders
  alter column platform_fee_bp set default 297;

-- 6. Enforce NOT NULL
alter table orders
  alter column platform_fee_bp set not null;

-- 7. Enforce CHECK constraint (between 0 and 1000 bp, i.e. 0% to 10%)
alter table orders
  drop constraint if exists orders_platform_fee_bp_check;

alter table orders
  add constraint orders_platform_fee_bp_check
  check (platform_fee_bp between 0 and 1000);


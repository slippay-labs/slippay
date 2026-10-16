-- Migration: add precision/scale, NOT NULL constraint, non-negative CHECK, and backfill fee_usdc on orders
-- Fixes: slippay-labs/slippay#99, slippay-labs/slippay#229

-- 1. Ensure quarantine table exists for auditing orphan orders lacking a matching merchant
create table if not exists orders_quarantine (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  merchant_id uuid,
  reason text not null,
  quarantined_at timestamptz not null default now()
);

-- 2. Add marker column to record whether a fee was inferred or officially calculated
alter table orders
  add column if not exists fee_inferred boolean not null default false;

comment on column orders.fee_inferred is 'True if fee was inferred or defaulted by migration due to missing merchant/historical data';

-- 3. Backfill existing orders where fee_usdc is NULL from matching merchant rate
update orders o
set fee_usdc = round(o.usdc_amount * coalesce(o.platform_fee_bp, m.platform_fee_bp, 297) / 10000.0, 7)
from merchants m
where o.merchant_id = m.id and o.fee_usdc is null;

-- 4. Audit & Quarantine orphan orders rather than silently zeroing business value
do $$
declare
  orphan_count int;
begin
  select count(*) into orphan_count
  from orders o
  left join merchants m on o.merchant_id = m.id
  where m.id is null and o.fee_usdc is null;

  if orphan_count > 0 then
    insert into orders_quarantine (order_id, merchant_id, reason)
    select o.id, o.merchant_id, 'orphan_order_lacking_merchant_at_fee_usdc_migration'
    from orders o
    left join merchants m on o.merchant_id = m.id
    where m.id is null and o.fee_usdc is null;

    -- For technical NOT NULL compliance without destroying evidence,
    -- record default fee marked explicitly with fee_inferred = true.
    update orders
    set fee_usdc = round(usdc_amount * 297 / 10000.0, 7),
        fee_inferred = true
    where fee_usdc is null;

    raise notice 'Quarantined and marked % orphan orders in fee_usdc migration', orphan_count;
  end if;
end $$;

-- 5. Set numeric precision and scale to numeric(20,7)
alter table orders
  alter column fee_usdc type numeric(20,7);

-- 6. Enforce NOT NULL
alter table orders
  alter column fee_usdc set not null;

-- 7. Enforce non-negative and max 7 decimal places check
alter table orders
  drop constraint if exists orders_fee_usdc_check;

alter table orders
  add constraint orders_fee_usdc_check
  check (fee_usdc >= 0 and scale(fee_usdc) <= 7);

-- 8. Ensure foreign key constraint exists on orders.merchant_id
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_merchant_id_fkey'
  ) then
    alter table orders
      add constraint orders_merchant_id_fkey
      foreign key (merchant_id) references merchants(id) on delete restrict;
  end if;
end $$;


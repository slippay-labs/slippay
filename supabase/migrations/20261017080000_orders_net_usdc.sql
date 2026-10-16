-- Migration: Add net_usdc numeric(20,7) column with conservation CHECK constraint to orders
-- Resolves: slippay-labs/slippay#201

-- 1. Add column if it doesn't already exist
alter table orders
  add column if not exists net_usdc numeric(20,7);

-- 2. Backfill existing rows using exact fee conservation (usdc_amount - fee_usdc)
update orders
set net_usdc = round(usdc_amount - coalesce(fee_usdc, 0), 7)
where net_usdc is null;

-- 3. Set NOT NULL constraint
alter table orders
  alter column net_usdc set not null;

-- 4. Add identity & scale CHECK constraint: net_usdc + fee_usdc = usdc_amount
alter table orders
  add constraint orders_net_usdc_sum_check
  check (
    net_usdc >= 0
    and scale(net_usdc) <= 7
    and net_usdc + fee_usdc = usdc_amount
  );

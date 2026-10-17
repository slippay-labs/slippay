-- Migration: calculate and backfill fee_usdc from order's immutable platform_fee_bp, enforce numeric(20,7), NOT NULL, and CHECK constraints
-- Fixes: slippay-labs/slippay#99, slippay-labs/slippay#227
--
-- Relies on 20261008120000_orders_platform_fee_bp_constraints having already guaranteed
-- that orders.platform_fee_bp is non-null and reflects historical truth.

-- 1. Backfill existing orders where fee_usdc is NULL using truncated integer-equivalent arithmetic
update orders
set fee_usdc = trunc(usdc_amount * platform_fee_bp / 10000.0, 7)
where fee_usdc is null;

-- 2. Fallback for 0 fee when usdc_amount was null or 0
update orders
set fee_usdc = 0
where fee_usdc is null;

-- 3. Set numeric precision and scale to numeric(20,7)
alter table orders
  alter column fee_usdc type numeric(20,7);

-- 4. Enforce NOT NULL
alter table orders
  alter column fee_usdc set not null;

-- 5. Enforce non-negative, <= gross amount, and max 7 decimal places check
alter table orders
  add constraint orders_fee_usdc_check
  check (fee_usdc >= 0 and fee_usdc <= usdc_amount and scale(fee_usdc) <= 7);

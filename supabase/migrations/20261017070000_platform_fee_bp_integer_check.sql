-- Migration: Enforce integer integrality on platform_fee_bp
-- Fixes: slippay-labs/slippay#225
--
-- Prevents fractional fee basis points (e.g. 297.5) from being stored,
-- ensuring that downstream BigInt conversions in listeners and off-chain
-- settlement engines never fail with an uncaught RangeError.

-- 1. Sanitize any legacy fractional values if present
update merchants
set platform_fee_bp = round(platform_fee_bp)::int
where platform_fee_bp is not null and platform_fee_bp != round(platform_fee_bp);

update orders
set platform_fee_bp = round(platform_fee_bp)::int
where platform_fee_bp is not null and platform_fee_bp != round(platform_fee_bp);

-- 2. Add CHECK constraint on merchants table
alter table merchants
  drop constraint if exists merchants_platform_fee_bp_integer_check;

alter table merchants
  add constraint merchants_platform_fee_bp_integer_check
  check (platform_fee_bp = round(platform_fee_bp));

-- 3. Add CHECK constraint on orders table
alter table orders
  drop constraint if exists orders_platform_fee_bp_integer_check;

alter table orders
  add constraint orders_platform_fee_bp_integer_check
  check (platform_fee_bp = round(platform_fee_bp));

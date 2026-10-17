-- Migration: historical fee timeline backfill, fee_inferred flag, enforce NOT NULL, default 297, and CHECK constraint [0, 1000]
-- Fixes: slippay-labs/slippay#96, slippay-labs/slippay#227
--
-- RULE: Never backfill financial history from current merchant configuration!
-- Historical timeline:
--   1. Prior to 2026-05-26 11:46:00 UTC: fee capture was not introduced. Backfill 0 bp and mark fee_inferred = true.
--   2. Between 2026-05-26 11:46:00 UTC and 2026-06-05 21:00:00 UTC: platform canonical default was 98 bp (0.98%).
--   3. After 2026-06-05 21:00:00 UTC: platform canonical default was 297 bp (2.97%).

-- 1. Add fee_inferred column to explicitly track backfilled / reconstructed historical rows
alter table orders
  add column if not exists fee_inferred boolean not null default false;

-- 2. Backfill pre-fee-snapshot era (< 2026-05-26 11:46:00+00)
update orders
set platform_fee_bp = 0,
    fee_inferred = true
where platform_fee_bp is null
  and created_at < '2026-05-26 11:46:00+00';

-- 3. Backfill 98 bp era (2026-05-26 11:46:00+00 to 2026-06-05 21:00:00+00)
update orders
set platform_fee_bp = 98,
    fee_inferred = true
where platform_fee_bp is null
  and created_at >= '2026-05-26 11:46:00+00'
  and created_at < '2026-06-05 21:00:00+00';

-- 4. Backfill 297 bp era (>= 2026-06-05 21:00:00+00)
update orders
set platform_fee_bp = 297,
    fee_inferred = true
where platform_fee_bp is null
  and created_at >= '2026-06-05 21:00:00+00';

-- 5. Set default to 297 (canonical default platform fee, 2.97%)
alter table orders
  alter column platform_fee_bp set default 297;

-- 6. Enforce NOT NULL
alter table orders
  alter column platform_fee_bp set not null;

-- 7. Enforce CHECK constraint (between 0 and 1000 bp, i.e. 0% to 10%)
alter table orders
  add constraint orders_platform_fee_bp_check
  check (platform_fee_bp between 0 and 1000);

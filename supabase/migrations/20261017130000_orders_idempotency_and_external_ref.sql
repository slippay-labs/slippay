-- 20261017130000_orders_idempotency_and_external_ref.sql
-- Enforce idempotency on order creation under network retries and concurrent submission (Issue #200).

-- 1. Add idempotency_key column to orders table
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- 2. Unique index on (merchant_id, idempotency_key) scoped to non-null keys
CREATE UNIQUE INDEX IF NOT EXISTS orders_merchant_id_idempotency_key_idx
  ON public.orders (merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Unique index on (merchant_id, external_ref) scoped to non-null references
CREATE UNIQUE INDEX IF NOT EXISTS orders_merchant_id_external_ref_idx
  ON public.orders (merchant_id, external_ref)
  WHERE external_ref IS NOT NULL;

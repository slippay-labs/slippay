-- Migration: enforce orders.fee_usdc <= orders.usdc_amount constraint
-- Fixes: slippay-labs/slippay#230
-- Guarantees the database-level invariant that the platform fee can never exceed gross amount,
-- protecting against application arithmetic bugs or malicious writers across all services.

-- 1. Defensively cap any historical anomalous rows if any exist
UPDATE public.orders
SET fee_usdc = usdc_amount
WHERE fee_usdc > usdc_amount;

-- 2. Add CHECK constraint enforcing fee_usdc <= usdc_amount
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_fee_le_gross_check,
  ADD CONSTRAINT orders_fee_le_gross_check
  CHECK (fee_usdc <= usdc_amount);

-- 3. If net_usdc column exists or is introduced, enforce merchant non-negative net amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'net_usdc'
  ) THEN
    ALTER TABLE public.orders
      DROP CONSTRAINT IF EXISTS orders_net_usdc_non_negative_check,
      ADD CONSTRAINT orders_net_usdc_non_negative_check
      CHECK (net_usdc >= 0);
  END IF;
END $$;

-- Migration: Add configurable per-merchant maximum order limits (Issue #208)
-- Prevents catastrophic unbounded liabilities and supports fraud risk controls per merchant.

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS max_order_usdc numeric(20,7) DEFAULT 50000.0000000 CHECK (max_order_usdc > 0),
  ADD COLUMN IF NOT EXISTS max_order_brl numeric(20,2) DEFAULT 300000.00 CHECK (max_order_brl > 0);

-- Migration: Add received_usdc and surplus_usdc to orders
-- Fixes: slippay-labs/slippay#232
--
-- Records the actual amount received and any residual surplus when a payment
-- exceeds the expected amount. Ensures overpayment is visible to merchants,
-- auditable, and traceable for refund/credit workflows.

alter table orders
  add column if not exists received_usdc numeric(12,7) check (received_usdc >= 0),
  add column if not exists surplus_usdc numeric(12,7) default 0 check (surplus_usdc >= 0);

comment on column orders.received_usdc is 'Actual USDC amount received on chain for this order';
comment on column orders.surplus_usdc is 'Excess USDC received beyond expected amount (surplus = received - expected)';

# Orphan Orders & Fee Integrity Specification

> **Status**: Approved & Implemented  
> **Scope**: Supabase Migrations, Database Integrity, Financial Audit Trail  
> **Reference Issue**: [#229](https://github.com/slippay-labs/slippay/issues/229)

---

## 1. Problem Context

In historical database migrations `20261008120000_orders_fee_usdc_constraints.sql` and `20261008130000_orders_platform_fee_bp_constraints.sql`, blanket fallbacks were introduced:
```sql
-- DANGEROUS HISTORICAL PATTERN:
update orders set fee_usdc = 0 where fee_usdc is null;
update orders set platform_fee_bp = 297 where platform_fee_bp is null;
```

### Why Silent Fallbacks are Harmful
1. **Destruction of Evidence**: Setting `fee_usdc = 0` unconditionally asserted that zero fee was due on the order. This permanently masked data defects or missing merchant links.
2. **Ambiguity Between Legitimate Zero-Fee and Defective Rows**: Once columns became `NOT NULL`, there was no method to distinguish an authentic 0 bps fee (promotional or non-custodial) from a row zeroed out because its merchant could not be resolved.
3. **Hidden Referential Integrity Violations**: `orders.merchant_id` is defined as `references merchants(id) on delete restrict`. An order without a matching merchant represents a corrupted record or historical orphaned import that must be quarantined and investigated, not normalized silently.

---

## 2. Policy: Audit, Quarantine, and Inferred Marking

### Rule
> **A migration fallback is a policy decision. Never pick one that destroys the evidence.**

### Implementation Architecture

1. **`orders_quarantine` Audit Table**:
   Any orphaned order lacking a matching merchant is enumerated and logged into `orders_quarantine` with its `order_id`, `merchant_id`, reason, and timestamp:
   ```sql
   create table if not exists orders_quarantine (
     id uuid primary key default gen_random_uuid(),
     order_id uuid not null,
     merchant_id uuid,
     reason text not null,
     quarantined_at timestamptz not null default now()
   );
   ```

2. **Explicit `fee_inferred` Marker Column**:
   To satisfy `NOT NULL` constraints on active production tables without obscuring data lineage, a boolean flag `fee_inferred boolean not null default false` is added to `orders`:
   - Genuinely calculated or merchant-configured fees have `fee_inferred = false`.
   - Any fallback or emergency backfill sets `fee_inferred = true`.

3. **Explicit Foreign Key Verification**:
   The migration verifies that `orders_merchant_id_fkey` (`orders.merchant_id -> merchants.id`) is enforced:
   ```sql
   alter table orders
     add constraint orders_merchant_id_fkey
     foreign key (merchant_id) references merchants(id) on delete restrict;
   ```

---

## 3. Operator Queries

To inspect quarantined orders and inferred fee records:
```sql
-- View all quarantined orphan orders
select * from orders_quarantine order by quarantined_at desc;

-- View orders with inferred fees requiring manual review
select id, merchant_id, usdc_amount, platform_fee_bp, fee_usdc, fee_inferred, created_at
from orders
where fee_inferred = true;
```

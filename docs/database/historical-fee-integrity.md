# Historical Fee Integrity & Chronological Isolation Policy

> Canonical Reference: `docs/database/historical-fee-integrity.md`  
> Cross-references: Issue #227, Issue #96, Issue #99, [trust-model.md](../security/trust-model.md).

---

## 1. Core Financial Principle

> **RULE**: Never backfill financial history from current merchant configuration! If the original fee rate was unknown or not captured at transaction time, record that it is unknown / inferred, and isolate it from commercial invoices.

Rewriting historical orders with a current fee rate (e.g., retroactively applying a 297 bp platform fee to orders completed during the 98 bp era or pre-fee era) fabricates revenue that was never contracted or charged, permanently distorting accounting ledgers.

---

## 2. Chronological Timeline of SlipPay Fee Tiers

1. **Pre-Snapshot Era (`< 2026-05-26 11:46:00 UTC`)**:
   - Platform had not yet introduced per-order fee persistence (`platform_fee_bp`, `fee_usdc`).
   - Historical rows are assigned `platform_fee_bp = 0`, `fee_usdc = 0`, and `fee_inferred = true`.
2. **98 bp (0.98%) Era (`2026-05-26 11:46:00 UTC` to `2026-06-05 21:00:00 UTC`)**:
   - Canonical platform fee was 98 bp (`20260526114600_platform_fee_98bp.sql`).
   - Orders without recorded fee snapshot are backfilled with `platform_fee_bp = 98` and marked `fee_inferred = true`.
3. **297 bp (2.97%) Era (`>= 2026-06-05 21:00:00 UTC`)**:
   - Canonical platform fee updated to 297 bp (`20260605210000_platform_fee_297bp.sql`).
   - Orders without snapshot are backfilled with `platform_fee_bp = 297` and marked `fee_inferred = true`.

---

## 3. Migration Dependency Ordering

- **`20261008120000_orders_platform_fee_bp_constraints.sql`**:
  - Adds `fee_inferred boolean not null default false`.
  - Backfills `platform_fee_bp` based strictly on `created_at` boundaries.
  - Enforces `NOT NULL`, default 297, and `CHECK (platform_fee_bp BETWEEN 0 AND 1000)`.
- **`20261008130000_orders_fee_usdc_constraints.sql`**:
  - Computes `fee_usdc` from `orders.platform_fee_bp` using integer-consistent truncation: `trunc(usdc_amount * platform_fee_bp / 10000.0, 7)`.
  - Never queries `merchants` table.
  - Enforces `numeric(20,7)`, `NOT NULL`, and `CHECK (fee_usdc >= 0 AND fee_usdc <= usdc_amount)`.

---

## 4. Billing Isolation

Commercial invoice aggregation (`GET /v1/billing/fees`) filters rows with `.eq("fee_inferred", false)`. Inferred rows remain visible for ledger audits but never generate retroactive merchant liability.

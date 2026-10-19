# SlipPay Fee Documentation (Canonical Reference)

This is the canonical documentation for SlipPay fee semantics and limits. The checkout contract implements these policies on-chain; this document explains the public behavior for merchants, integrators, and auditors.

## Fee Rate (`fee_bps` / `platform_fee_bp`)

- **Unit:** Basis points (bp). The value represents `n / 10_000`, so `1 bp = 0.01%`.
- **Permitted range in the checkout contract:** `0 <= fee_bps <= 10_000` (0% to 100%). The constructor rejects `fee_bps > 10_000` with `BadConfig`.
- **Permitted range in the orders table:** `0 <= platform_fee_bp <= 1000` (0% to 10%). Enforced by a CHECK constraint on the `orders` table (migration `20261008130000`). The default is `297` (2.97%).
- **Inclusivity:** Both the minimum (0) and maximum (10_000 in contract, 1000 in orders) are inclusive.
- **Out-of-range behavior:** If a caller supplies `fee_bps > 10_000` to the checkout contract's `__constructor`, the deployment fails with `Error::BadConfig`. If `platform_fee_bp` is set outside `[0, 1000]` on an order, the database constraint rejects the write.

> **Note:** There is a discrepancy between the two boundaries. The checkout contract permits up to 10,000 bp (100%), while the orders table constrains `platform_fee_bp` to 0–1000 bp (0–10%). Integrators should use the orders table constraint (max 1000 bp) when creating orders through the API, but the on-chain contract itself allows a higher rate.

## Fee Formula

The on-chain fee calculation in the checkout contract uses integer arithmetic:

```
fee = amount * fee_bps / 10_000
net = amount - fee
```

- **Units:** `amount`, `fee`, and `net` all share the same unit as the token being transferred (e.g., USDC micro-units, native XLM stroops).
- **Rounding:** Rust integer division truncates toward zero. For positive `amount` and `fee_bps`, the result is the floor of the exact rational result. This means the merchant receives at most the truncated amount; the fractional part (at most 1 unit) is lost to the fee, favoring the merchant by at most one stroop/micro-unit when the division is inexact.
- **Example:** `amount = 1005`, `fee_bps = 300` → `fee = 1005 * 300 / 10_000 = 301_500 / 10_000 = 30` (truncated), `net = 1005 - 30 = 975`. The exact proportion would be `1005 * 0.03 = 30.15`, truncated to 30.

The off-chain invoice (`fee_usdc`) uses a separate calculation:

```
fee_usdc = round(usdc_amount * platform_fee_bp / 10000.0, 7)
```

This uses floating-point division with rounding to 7 decimal places. Because the on-chain calculation truncates (rounds toward negative infinity for positive values) while the off-chain calculation rounds to nearest, the two fees may differ by up to 1 unit in the last decimal place of `fee_usdc`.

## Zero-Net Behavior

- When `fee_bps = 10_000` (100%), `fee = amount` and `net = 0`. The entire payment goes to the fee recipient, and the merchant receives 0.
- The contract does **not** explicitly reject a zero-net result. `amount > 0` is required (via `BadAmount` check), but `net` can be 0.
- When `fee_bps = 0`, `fee = 0` and `net = amount`. The merchant receives the full amount; no fee is transferred.

> **Warning:** A zero-net payment is not an error per the contract code, but it means the merchant receives nothing. Callers should verify the intended `fee_bps` before expecting a non-zero net.

## Maximum-Rate Behavior

- `fee_bps = 10_000` produces `fee = amount` and `net = 0`. This is the maximum feasible outcome; the contract does not prevent the fee from consuming the entire payment.
- The contract does not apply a secondary cap that would prevent the fee from equalling the full amount. The `fee_bps <= 10_000` check is the only guard.

## Atomicity and Token Reverts

- Both transfers (merchant net and fee to SlipPay) are **atomic**: they are two nested SEP-41 transfers within a single Soroban contract call.
- **If either transfer fails** (e.g., insufficient balance, frozen account, token contract revert), **the entire transaction reverts**. No partial state changes persist.
- The contract takes `from.require_auth()` once, and the payer authorizes the whole charge in a single operation.
- The contract emits a `checkout_paid` event **only if both transfers succeed**. If either fails, the event is not emitted and all state changes are reverted.

> **Soroban guarantee:** Soroban executes the `pay` function as one atomic invocation. Any panic (including failed `client.transfer()` calls) causes the whole invocation to revert, undoing both transfers.

## Relationship to `fee_usdc`

- **On-chain (authoritative):** The `pay` entrypoint computes `fee = amount * fee_bps / 10_000` using integer truncation. This is the definitive fee amount that moves on-chain.
- **Off-chain (invoiced):** The merchant's invoice uses `fee_usdc = round(usdc_amount * platform_fee_bp / 10000.0, 7)`, calculated in decimal arithmetic and rounded to 7 decimal places.
- **Mapping:** The off-chain `fee_usdc` is intended to represent the same proportional fee as the on-chain calculation, but the different rounding methods (round vs. truncate) mean the two amounts may not be identical. The discrepancy is at most 1 unit in the 7th decimal place of `fee_usdc`.
- **Which is authoritative?** The on-chain `pay` entrypoint is authoritative for what actually moves on-chain. The off-chain `fee_usdc` is the invoiced amount; if a merchant pays attention to the exact on-chain fee, they should read the `checkout_paid` event's `fee` value rather than relying solely on the invoiced `fee_usdc`.

## Contract Addresses

- **Testnet:** `CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ`
  - Deployed 2026-06-05 with `fee_bps = 300` (3%), `fee_to = GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4`
- **Mainnet:** Pending deployment. The same contract logic will be used with the mainnet `slippay-fee` address and a USDC SAC as the token.

## Cross-Reference

- This document is the canonical reference for fee policy. The checkout contract source (`contracts/checkout/src/lib.rs`) and deployment record (`contracts/checkout/DEPLOYMENT.md`) describe how that policy is implemented and enforced on-chain.
- The orders table constraints (CHECK `platform_fee_bp between 0 and 1000`) are documented in the database migrations under `supabase/migrations/`.
- The off-chain invoicing calculation appears in the order-creation and rate-management code paths (see `supabase/migrations/20261008120000_orders_fee_usdc_constraints.sql` for the backfill formula).
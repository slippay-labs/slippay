# Overpayment Policy & Residual Handling

> **Status**: Accepted & Active  
> **Scope**: Payment matching, reconciliation, order storage, and webhooks (`@slippay/listener`)  
> **Reference Issue**: [#232](https://github.com/slippay-labs/slippay/issues/232)

---

## 1. Problem Statement

In cryptocurrency payment rails (such as Stellar USDC), buyers may send an amount that exceeds the order's expected merchant net. Common causes include:
- Manual transfer typos or transposing digits (e.g., typing `12.5` instead of `1.25`).
- Sending extra funds to "cover hypothetical fees".
- Duplicate payments against the same memo.

Previously, `matchPaymentToOrder` evaluated `receivedStroops >= expectedStroops` and silently emitted `{ outcome: "paid" }` without recording the surplus. As a result:
- The surplus was discarded from the outcome record.
- The merchant and customer had no visibility into excess funds received.
- No audit trail or refund trigger existed for large accidental overpayments.

---

## 2. Policy: Accept-and-Record Residual with Alert Threshold

SlipPay adopts the **Accept-and-Record Residual** policy:

1. **Order Fulfillment (`outcome: "paid"`)**:
   - The transaction settles the order immediately (`status = 'paid'`). The buyer's fulfillment is not blocked or delayed by an accidental overpayment.
2. **Explicit Residual Persistence**:
   - The `MatchOutcome` for `"paid"` explicitly includes:
     - `expected`: The exact expected merchant share (e.g. `"1.0000000"`).
     - `received`: The actual on-chain amount received (e.g. `"2.5000000"`).
     - `surplus`: The difference in Stellar decimal format (`received - expected`, e.g. `"1.5000000"`). When the payment is exact, `surplus = "0.0000000"`.
   - The reconciler persists `received_usdc` and `surplus_usdc` directly on the `orders` table.
3. **Webhook Visibility**:
   - The outgoing `order.paid` (or `subscription.charged`) webhook payload includes `expected`, `received`, and `surplus` in its `data` dictionary, giving merchants real-time notification to trigger internal credit/refund workflows.
4. **Structured Monitoring & Overpayment Alerts**:
   - Any non-zero surplus logs an informative `order_overpayment_recorded` event.
   - If the surplus meets or exceeds the configurable alert threshold `OVERPAYMENT_ALERT_THRESHOLD_USDC` (default: **`1.0000000` USDC**), an `order_overpayment_alert` warning event is emitted to notify operators of a possible duplicate transfer or input mistake.

---

## 3. Configuration

| Environment Variable | Default | Description |
| :--- | :---: | :--- |
| `OVERPAYMENT_ALERT_THRESHOLD_USDC` | `"1.0000000"` | Surplus amount in USDC that triggers an alert-level log for human inspection or automated alerting. |

---

## 4. Code References

- **Matcher**: `apps/listener/src/matcher.ts` (`matchPaymentToOrder`)
- **Reconciler**: `apps/listener/src/reconciler.ts` (`reconcileMatch`)
- **Database Schema**: `supabase/migrations/20261017073000_orders_overpayment_surplus.sql`

# Billing

SlipPay collects a platform fee on each paid order. The billing endpoint
aggregates the per-order fee already persisted on `orders.fee_usdc` into a
billable total for a period — the data SlipPay invoices the merchant from.
It is a read-only aggregate; creating or paying an invoice is out of scope.

> **Auth**: API key (`Bearer sk_live_...`) or Supabase JWT on the single route.

## Get fee totals

`GET /api/v1/billing/fees[?from=ISO8601&to=ISO8601]`

### Query parameters

| param | type | default | notes |
|---|---|---|---|
| `from` | ISO 8601 | first instant of the current calendar month (server local time) | lower bound on `paid_at`, inclusive |
| `to` | ISO 8601 | now | upper bound on `paid_at`, inclusive |

Only orders with `status = 'paid'` and `paid_at` inside the window are counted.
The fee used is the value stored on the order at creation time, so later
platform-fee changes do not rewrite historical periods.

### Response

`200 OK`

```json
{
  "merchant_id": "mer_a1b2c3...",
  "period": {
    "from": "2026-10-01T03:00:00.000Z",
    "to": "2026-10-19T18:24:00.000Z"
  },
  "orders_count": 42,
  "gross_usdc": "762.1400000",
  "fee_usdc_total": "22.6283580",
  "net_usdc_total": "739.5116420",
  "platform_fee_bp": 297
}
```

| field | type | notes |
|---|---|---|
| `merchant_id` | uuid | the authenticated merchant |
| `period.from` | ISO 8601 | resolved lower bound |
| `period.to` | ISO 8601 | resolved upper bound |
| `orders_count` | int | number of paid orders in the window |
| `gross_usdc` | string | sum of `orders.usdc_amount`, 7 decimals |
| `fee_usdc_total` | string | sum of `orders.fee_usdc` — the billable amount, 7 decimals |
| `net_usdc_total` | string | `gross_usdc - fee_usdc_total`, 7 decimals |
| `platform_fee_bp` | int | the merchant's configured fee in basis points |

`platform_fee_bp` reflects the merchant's current configuration. The monetary
totals always come from the values stored on each order, so the rate shown is
context, not a multiplier to apply yourself.

### Errors

| status | code | when |
|---|---|---|
| 400 | `operation_failed` | the aggregate query failed |
| 400 | `value_invalid` / `value_out_of_range` | malformed persisted number |
| 401 | `unauthenticated` | missing or invalid API key / JWT |
| 403 | `forbidden` | database permission denied |
| 404 | `not_found` | a single-row expectation found nothing |
| 409 | `constraint_violation` / `conflict_retry` | constraint conflict or retryable concurrency failure |
| 500 | `internal_error` | unmapped database failure |

Database errors are translated by the shared mapper; the raw Postgres message is
never returned. See [Errors](./errors.md).

## Relationship to orders

- `POST /api/v1/orders` and the listener set `usdc_amount`, `fee_usdc` and
  `platform_fee_bp` when the order is created/paid.
- This endpoint does not settle anything on-chain. It reports the off-chain fee
  ledger (capture model A).
- For subscription charges, the underlying paid orders are included in the same
  window because they are ordinary `orders` rows with `subscription_id` set.

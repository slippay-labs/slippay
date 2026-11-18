# Metrics

A public snapshot of SlipPay's subscription intelligence, sourced from the Dune
dashboard at [dune.com/slippay/subscription-intelligence](https://dune.com/slippay/subscription-intelligence).
The endpoint is public on purpose: the thesis is "verifiable on-chain, audit it
yourself", so no API key is required.

> **Auth**: none.

## Get the Dune snapshot

`GET /api/v1/metrics/dune-snapshot`

### Unconfigured response

When the Dune query IDs or API key are not configured yet, the endpoint says so
and returns **no numbers**. It never fabricates a value.

`200 OK`

```json
{
  "configured": false,
  "contract_id": "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN",
  "dashboard_url": "https://dune.com/slippay/subscription-intelligence",
  "note": "Dashboard not published yet — published once real mainnet subscription data exists."
}
```

### Configured response

`200 OK`

```json
{
  "configured": true,
  "contract_id": "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN",
  "dashboard_url": "https://dune.com/slippay/subscription-intelligence",
  "fetched_at": "2026-10-19T18:24:00.000Z",
  "metrics": {
    "active_subscriptions": [ { "active": 128 } ],
    "mrr_usd": [ { "mrr": 412.55 } ],
    "churn_30d": [ { "churn": 0.021 } ],
    "cohort_retention": [ { "cohort": "2026-09", "retained": 0.94 } ]
  }
}
```

| field | type | notes |
|---|---|---|
| `configured` | bool | `false` when Dune is not wired |
| `contract_id` | string | Soroban subscription contract the metrics describe |
| `dashboard_url` | string | human-readable Dune dashboard |
| `fetched_at` | ISO 8601 | when the cached snapshot was assembled |
| `metrics` | object | one entry per metric family |

Each `metrics.*` value is one of:

- an array of rows returned verbatim by the Dune query;
- `null` when that query ID is not configured;
- `{ "error": "..." }` when Dune returned an error for that query.

The endpoint intentionally does not reshape rows into metric-specific schemas.
Read the Dune query output for the exact column names.

### Caching

Configured results are cached in-process for **1 hour**. `fetched_at` is the
cache-fill time, not the time of your request. Dune's rate limit is therefore
not hit on every page view. The unconfigured response is cheap and not cached.

### Errors

The endpoint itself does not return a 5xx for Dune failures; per-query failures
are surfaced inside `metrics` as `{ "error": ... }`. A missing API key or no
wired query IDs is a valid `configured: false` response, not an error.

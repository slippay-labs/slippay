# API reference

SlipPay's HTTP API is mounted under `/api` and served from
`https://api.slippay.cc`. This page is the index of every route group mounted by
`supabase/functions/api/index.ts`. Each group is either documented on its own
page or explicitly marked **internal** / **provider-facing** below, so an
omission is deliberate rather than accidental.

## Authentication at a glance

| surface | mechanism | header |
|---|---|---|
| Merchant API | API key | `Authorization: Bearer sk_live_...` |
| Dashboard / self-management | Supabase JWT | `Authorization: Bearer eyJ...` |
| Provider webhooks | provider-specific HMAC/JWT | varies by provider |
| Webhook receiver (your side) | HMAC-SHA256 of the raw body | `X-Slippay-Signature: <hex>` |

See [Authentication](./authentication.md) for issuing, rotating and using keys,
and [Errors](./errors.md) for the shared error envelope.

## Mounted route groups

| mount | purpose | auth | reference |
|---|---|---|---|
| `/api/health` | liveness probe | public | [Health](#health) |
| `/api/v1/merchants` | create and manage the merchant, rotate API keys | JWT | [Merchants](./merchants.md) |
| `/api/v1/orders` | one-shot payments and hosted checkout | API key; `GET /:id` is public | [Orders](./orders.md) |
| `/api/v1/subscriptions` | recurring billing and manual charges | API key | [Subscriptions](./subscriptions.md) |
| `/api/v1/billing` | platform-fee totals for a period | API key or JWT | [Billing](./billing.md) |
| `/api/v1/metrics` | public subscription-intelligence snapshot | public | [Metrics](./metrics.md) |
| `/api/v1/ask` | Ask Slippay concierge (SSE) | public, origin-gated | [Ask Slippay](./ask.md) |
| `/api/v1/x402-resources` | merchant-side x402 resource management | API key | [x402](./x402.md) |
| `/api/v1/x402` | payer-side HTTP 402 gated resources | public | [x402](./x402.md) |
| `/api/v1/relayer` | gas sponsorship for passkey payments | public, rate-limited | [Relayer](./relayer.md) |
| `/api/v1/ramp` | ramp-provider webhook intake | provider JWT (`CRIPTOPIX_CLIENT_SECRET`) | [Ramp webhooks](./ramp.md) |
| `/api/v1/offramp` | provider-agnostic on/off-ramp | API key or JWT; `GET /status` is public | [On/off-ramp](./offramp.md) |
| `/api/v1/4p` | 4P Finance Pix ramp (on/off-ramp) | origin-gated public; provider webhook | [4P Finance](./fourp.md) |

That is the full set of groups mounted in `index.ts`: thirteen including
`/api/health`. `authentication`, `webhooks` and `errors` are cross-cutting
reference pages, not additional mounts.

## Explicitly internal or non-API surfaces

These are mounted by the same process but are not part of the public API
contract:

| surface | why it is not public API |
|---|---|
| `/shopify/*` | Internal reverse proxy from the API process to the Shopify connector on `:4001`. Both HMAC checks happen in the connector against the raw bytes. Integrators use the connector's own routes, not this proxy. |
| `/docs`, `/docs/*` | 301 redirect to the hosted GitBook docs. |
| `/*` on `api.slippay.cc` | Non-`/api/*` paths redirect to `https://app.slippay.cc`. |
| `/*` on other hosts | Static web app / SPA fallback. Not an API surface. |

`/api/v1/ramp` is intentionally provider-facing: it is the webhook receiver for
CriptoPix status notifications, not an integrator endpoint. It is documented in
[ramp.md](./ramp.md) so the async status model is legible, but clients should
read status through [On/off-ramp](./offramp.md) or
[4P Finance](./fourp.md).

## Health

`GET /api/health`

Public, unauthenticated liveness probe.

```json
{ "ok": true }
```

## Conventions

- Requests and responses are JSON unless stated otherwise. `POST` bodies use
  `Content-Type: application/json`.
- Stellar/USDC amounts are decimal strings, never floats. USDC uses up to 7
  fractional digits (Stellar precision); BRL uses 2. The 4P ramp is the
  exception: its routes accept and return JSON numbers, documented in
  [4P Finance](./fourp.md).
- Errors use the envelope in [Errors](./errors.md): `{ "error": "<code>",
  "detail"?: "...", "issues"?: [...] }`.
- Every `/api/*` request passes through a global token bucket: 120 requests
  burst, refilling at 2/second, keyed by the trusted connection IP. Individual
  routes add stricter buckets on top. Exhausted callers receive `429` with
  `{ "error": "rate_limited", "scope": "...", "retry_after_sec": N }` and a
  `retry-after` header.
- `401 unauthenticated` is returned for a missing/invalid API key or JWT. It
  does not distinguish "unknown key" from "inactive merchant".

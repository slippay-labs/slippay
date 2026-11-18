# Ramp webhooks

This is the **provider-facing** webhook intake for ramp status. It is not an
integrator API. Today it receives CriptoPix transaction notifications and
mirrors them into the `ramp_transactions` store so the on/off-ramp read methods
can resolve a status later.

> **Auth**: the provider's HS256 JWT in `Authorization: Bearer <token>`, signed
> with `CRIPTOPIX_CLIENT_SECRET`. There is no SlipPay API key on this route.

## Why a store

Charge-model providers such as CriptoPix do not expose a GET-by-id status
endpoint. Status arrives only by webhook. `lib/ramp/store.ts` persists each
notification to `ramp_transactions`, keyed by `gateway_id` (falling back to
`partner_transaction_id` when the gateway id is absent). The Anchor read methods
then resolve against that store.

This is the asynchronous model for the ramp surfaces:

```text
provider status change
        │
        ▼
POST /api/v1/ramp/criptopix/webhook   (this page)
        │  verify JWT → upsert
        ▼
ramp_transactions (gateway_id)
        │
        ▼
GET /api/v1/offramp/order/:id
GET /api/v1/offramp/onramp/:id
GET /api/v1/4p/onramp/:id
GET /api/v1/4p/offramp/:id
```

Do not poll the provider for a CriptoPix transaction; poll the Slippay status
route. The store is the source of truth for that provider.

## Health probe

`GET /api/v1/ramp/criptopix/webhook`

Always `200 OK`. Lets the provider (or a browser) confirm the URL is alive
before enabling the integration.

```json
{ "ok": true, "endpoint": "criptopix-webhook", "method": "POST" }
```

## Receive a CriptoPix notification

`POST /api/v1/ramp/criptopix/webhook`

### Authentication

1. `Authorization: Bearer <jwt>` is required once `CRIPTOPIX_CLIENT_SECRET` is
   configured.
2. The JWT must be HS256, have three dot-separated parts, and verify against
   the secret. Its payload carries `businessId`.
3. If `CRIPTOPIX_BUSINESS_ID` is set, `payload.businessId` must equal it.

When `CRIPTOPIX_CLIENT_SECRET` is not set, the route is gated: it acknowledges
with `200 { "ok": true, "gated": true }` so the provider can register and
validate the URL. No notification is stored in that state.

### Request body

```json
{
  "ids": {
    "businessId": "biz_123",
    "transactionId": "tx_123",
    "partnerTransactionId": "partner_123",
    "gatewayId": "gw_123",
    "brCode": "000201...",
    "endToEndId": "E123...",
    "afterPaymentId": "ap_123",
    "hashWeb3": "0xabc..."
  },
  "transactionPayload": {
    "userId": "user_123",
    "userCpf": "12345678901",
    "userPixKey": "user@example.com",
    "userWalletAddress": "0x...",
    "productName": "On-ramp",
    "quantity": 1,
    "unitPrice": 100,
    "usdtAmount": 18.16,
    "reaisAmount": 100
  },
  "transactionType": "PIX_PURCHASE",
  "transactionStatus": "paid",
  "transactionErrorType": null,
  "transactionErrorMessage": null
}
```

| field | notes |
|---|---|
| `ids.gatewayId` | preferred upsert key |
| `ids.partnerTransactionId` | fallback key when `gatewayId` is absent |
| `ids.*` | other identifiers stored as-is; `"-NOT-UPDATED"`-suffixed values are treated as absent |
| `transactionPayload.*` | user and amount context stored with the row |
| `transactionType` | provider transaction type |
| `transactionStatus` | provider status string (e.g. `pending`, `processing`, `completed`, `failed`, `expired`, `cancelled`, `refunded`) |
| `transactionErrorType` / `transactionErrorMessage` | failure context, if any |

### Response

`200 OK` is returned **only after a successful upsert**, so the provider retries
on a transient failure:

```json
{ "ok": true, "id": "gw_123" }
```

| status | body | when |
|---|---|---|
| 200 | `{ "ok": true, "id": "..." }` | stored |
| 200 | `{ "ok": true, "gated": true }` | secret not configured |
| 401 | `{ "error": "missing_token" }` | no bearer token |
| 401 | `{ "error": "invalid_token" }` | bad JWT signature/shape |
| 401 | `{ "error": "business_mismatch" }` | pinned business id differs |
| 400 | `{ "error": "bad_json" }` | body is not JSON |
| 422 | `{ "error": "no_transaction_id" }` | neither gateway nor partner id usable |
| 502 | `{ "error": "store_failed", "message": "..." }` | upsert failed; safe for the provider to retry |

## Receiver pinning on a sell

The webhook intake records status; it does not choose or trust a receiver.
Receiver pinning is enforced when the sell order is created:

- `POST /api/v1/4p/offramp` checks the provider-returned `receiver_wallet`
  against `FOURP_OFFRAMP_RECEIVER` server-side and fails closed with
  `502 receiver_mismatch` before the client is asked to sign;
- the web client independently pins the same address
  (`VITE_4P_OFFRAMP_RECEIVER`) and asserts it before signing.

See [4P Finance](./fourp.md#receiver-pinning) for the full contract. The
provider-agnostic Etherfuse flow returns a signable transaction instead; the
caller must verify its recipient before signing (see
[On/off-ramp](./offramp.md#asynchronous-status-and-signing)).

## Configuration

| variable | purpose |
|---|---|
| `CRIPTOPIX_CLIENT_SECRET` | HS256 secret for webhook JWT verification; unset = gated |
| `CRIPTOPIX_BUSINESS_ID` | optional pin on the JWT `businessId` claim |
| `CRIPTOPIX_ENABLED` / `CRIPTOPIX_CLIENT_ID` / `CRIPTOPIX_BASE_URL` | provider activation for the read side |

The secret is a shared secret with the provider. Anyone holding it can forge a
notification, so it must never be exposed to a browser or logged.

# 4P Finance

The 4P Finance ramp: Pix BRL → crypto (on-ramp) and crypto → Pix BRL
(off-ramp), using 4P's partner REST API. 4P is a Brazilian PSP; it has **no
Stellar support**. The configured chain is `Base` by default and the asset is
USDC, so `receiverWallet` / `senderWallet` in this section are EVM addresses,
not Stellar public keys.

The 4P `x-api-key` is held server-side and is never proxied to the browser. The
surface is **dormant** until `FOURP_API_KEY` is set.

## Routes

| route | auth | purpose |
|---|---|---|
| `GET /api/v1/4p/status` | public | is 4P configured? |
| `POST /api/v1/4p/webhook` | 4P server-to-server | notification token intake |
| `POST /api/v1/4p/quote` | origin-gated | BRL → crypto quote |
| `POST /api/v1/4p/onramp` | origin-gated | create a Pix charge |
| `GET /api/v1/4p/onramp/:id` | origin-gated | status from the webhook store |
| `POST /api/v1/4p/offramp/quote` | origin-gated | crypto → BRL quote |
| `POST /api/v1/4p/offramp` | origin-gated | create a sell |
| `GET /api/v1/4p/offramp/:id` | origin-gated | status from the webhook store |

Origin-gated routes require an allowlisted `Origin` (or `Referer`). The comex
user authenticates with Privy, not with a SlipPay API key or JWT, so these
routes are public but cannot be called from an arbitrary server-side script
without an allowlisted origin. Charges are self-paid in R$, so there is no
fund-theft vector on the on-ramp.

Rate limits: quote 20 requests burst / 20 per minute; on-ramp create 10 burst /
10 per minute; status routes 30 burst / 30 per minute; the same shape applies to
off-ramp.

## Status

`GET /api/v1/4p/status`

```json
{
  "enabled": true,
  "provider": "4p",
  "chain": "Base",
  "asset": "USDC",
  "rails": ["pix"]
}
```

Dormant:

```json
{ "enabled": false }
```

## Quote an on-ramp

`POST /api/v1/4p/quote`

```json
{ "amountBrl": 100 }
```

`amountBrl` must be a positive number.

### Response

```json
{
  "quote": {
    "amount": "100",
    "symbol": "USDC",
    "quote": {
      "USDC": { "price": 0.17496, "last_updated": "2026-10-19T18:24:00Z" }
    }
  },
  "gross": { "USDC": 0.18 },
  "marginBps": 280
}
```

| field | notes |
|---|---|
| `quote` | 4P's quote with Slippay's margin applied |
| `gross` | the pre-margin price per asset, for transparent fee display |
| `marginBps` | applied spread, default `280` (2.80%) |

`FOURP_MARGIN_BPS` overrides the margin; values outside `0..1000` fall back to
280. The net price is computed with integer basis points and **rounded down**
(`Math.floor`) to 6 decimals, in the platform's disfavour. See
[4P on-ramp margin & rounding](../integrations/ramp-rounding.md).

## Create an on-ramp

`POST /api/v1/4p/onramp`

```json
{
  "amountBrl": 100,
  "receiverWallet": "0x...",
  "email": "user@example.com",
  "cpf": "12345678901",
  "customId": "slp-...",
  "description": "Slippay on-ramp",
  "chain": "Base",
  "asset": "USDC"
}
```

| field | required | notes |
|---|---|---|
| `amountBrl` | yes | minimum 0.01 |
| `receiverWallet` | yes | address that receives the crypto on the configured chain |
| `email` | yes | payer email |
| `cpf` / `cnpj` | one of | Brazilian tax id; request fails if both are absent |
| `customId` | no | idempotency-style client id; generated as `slp-<uuid>` when absent |
| `description` | no | max 140 chars |
| `chain` / `asset` | no | override the server default for this order |

### Response

`201 Created`

```json
{
  "order": {
    "id": "slp-8f1c...",
    "txid": "tx_123",
    "pixCopiaECola": "000201...",
    "status": "pending"
  }
}
```

Render `pixCopiaECola` as the Pix copy-paste / QR payload. The order is also
seeded into the ramp store before the first webhook, so status polling works
immediately.

## Fetch an on-ramp

`GET /api/v1/4p/onramp/:id`

Returns the stored ramp record:

```json
{
  "order": {
    "gatewayId": "slp-8f1c...",
    "transactionId": "tx_123",
    "provider": "4p",
    "transactionType": "PIX_PURCHASE",
    "transactionStatus": "paid",
    "reaisAmount": 100,
    "raw": { ... }
  }
}
```

`404 not_found` when the id is unknown. `503 ramp_disabled` when the API key is
not configured.

## Quote an off-ramp

`POST /api/v1/4p/offramp/quote`

```json
{ "amountUsdc": 1 }
```

`amountUsdc` must be positive.

### Response

```json
{
  "brlOut": 5.25,
  "receiver": "0x...",
  "asset": "USDC",
  "marginBps": 280
}
```

`brlOut` is the post-margin BRL payout, rounded to 2 decimals. `receiver` is the
server-side pinned address (`FOURP_OFFRAMP_RECEIVER`) or `null` when no pin is
configured. The same `FOURP_MARGIN_BPS` default (280) applies.

## Create an off-ramp (sell)

`POST /api/v1/4p/offramp`

```json
{
  "amountUsdc": 25,
  "pixKey": "user@example.com",
  "senderWallet": "0x...",
  "email": "user@example.com",
  "cpf": "12345678901",
  "customId": "slp-off-..."
}
```

| field | required | notes |
|---|---|---|
| `amountUsdc` | yes | minimum 0.01 |
| `pixKey` | yes | destination Pix key |
| `senderWallet` | yes | wallet sending the crypto |
| `email` | yes | payer email |
| `cpf` / `cnpj` | one of | required |
| `customId` | no | generated as `slp-off-<uuid>` when absent |

### Response

`201 Created`

```json
{
  "id": "slp-off-8f1c...",
  "receiver": "0x...",
  "amount": "25"
}
```

The caller must send `amount` of the configured asset to `receiver` on the
configured chain, then poll for status. The receiver is pinned — see below.

## Fetch an off-ramp

`GET /api/v1/4p/offramp/:id`

```json
{ "transactionStatus": "paid" }
```

`404 not_found` for an unknown id.

## Receiver pinning

The sell flow moves money, so the destination address is pinned at two layers:

1. **Server (authoritative).** After 4P returns `receiver_wallet`,
   `POST /api/v1/4p/offramp` compares it to `FOURP_OFFRAMP_RECEIVER` (if set)
   case-insensitively. On a mismatch it returns
   `502 { "error": "receiver_mismatch", "message": "4P receiver did not match the pinned address" }`
   and does **not** persist an order or return a receiver to the client. This
   is fail-closed.
2. **Client (defence in depth).** The web app asserts the returned receiver
   equals `VITE_4P_OFFRAMP_RECEIVER` before asking the wallet to sign. If it
   differs, the signing flow stops.

Do not send funds to a receiver that was not checked against the pin. A missing
pin on the server (`null` in the quote response) means the deployment is not
configured for fail-closed selling; treat that as unsafe for production.

## Sell flow in order

1. `POST /offramp/quote` with `amountUsdc`; read `brlOut` and `receiver`.
2. Assert `receiver` equals `VITE_4P_OFFRAMP_RECEIVER` before doing anything
   else. If it is `null` or differs, stop.
3. `POST /offramp`; the server re-checks the receiver against
   `FOURP_OFFRAMP_RECEIVER` and fails closed.
4. Send exactly `amount` of the configured asset to `receiver` on the
   configured chain.
5. Poll `GET /offramp/:id` until `transactionStatus` is terminal.

For an on-ramp: `POST /quote`, `POST /onramp`, render `pixCopiaECola`, then poll
`GET /onramp/:id`.

## Webhook and asynchronous status

4P's webhook is **two-step**. 4P posts only a notification token; Slippay then
pulls the real status from 4P with the server-held API key:

```text
4P POST /api/v1/4p/webhook { token }
        │
        ▼
GET https://api.4p.finance/v1/notification/:token   (x-api-key)
        │
        ▼
ramp_transactions (gateway_id = custom_id || txid)
        │
        ▼
GET /api/v1/4p/onramp/:id  or  GET /api/v1/4p/offramp/:id
```

`POST /api/v1/4p/webhook` accepts `token`, `notification_token` or
`notificationToken` in the JSON body, or `?token=` / `?notification_token=` in
the query. The token alone is not trusted as status; only the authenticated pull
is. Requests from 4P's documented egress IP are preferred, but the IP check is
log-only — token resolution is the real authentication.

Because status is delivered asynchronously, a successful create only means the
order exists. Poll the status route until a terminal state (`paid`, `completed`,
`failed`, `expired`, `cancelled`, `refunded`, or the provider's equivalent).
For an on-ramp, `pixCopiaECola` being returned does not mean the Pix has been
paid.

## Errors

| status | code | when |
|---|---|---|
| 400 | `validation_error` | zod failed; `issues` present |
| 400 | `validation_error` + `message` | `cpf or cnpj required` |
| 400 | `missing_token` | webhook body/query had no token |
| 403 | `origin_required` | origin-gated route called with no `Origin`/`Referer` |
| 403 | `origin_not_allowed` | origin is not allowlisted |
| 422 | `no_id` | 4P notification had neither `custom_id` nor `txid` |
| 429 | `rate_limited` | route bucket exhausted |
| 502 | `fourp_error` / `ramp_error` | upstream 4P error or unexpected failure |
| 502 | `receiver_mismatch` | sell receiver did not match the pin |
| 503 | `ramp_disabled` | `FOURP_API_KEY` not configured |

## Configuration

| variable | default | purpose |
|---|---|---|
| `FOURP_API_KEY` | — | 4P partner key; unset = dormant |
| `FOURP_BASE_URL` | `https://api.4p.finance` | 4P API origin |
| `FOURP_CHAIN` | `Base` | settlement chain for on/off-ramp |
| `FOURP_ASSET` | `USDC` | settlement asset |
| `FOURP_MARGIN_BPS` | `280` | Slippay spread, 0–1000 |
| `FOURP_WEBHOOK_BASE` | `https://api.slippay.cc/api` | base used to build the notification URL |
| `FOURP_OFFRAMP_RECEIVER` | — | pinned sell receiver; set in production |
| `VITE_4P_OFFRAMP_RECEIVER` | — | client-side copy of the same pin |

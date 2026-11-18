# On/off-ramp

The provider-agnostic fiat ramp surface: quotes, customer/KYC, on-ramp
(fiat → crypto), off-ramp (crypto → fiat), and status. All handlers route
through an `Anchor` implementation. Etherfuse is the default provider; CriptoPix
takes precedence when configured.

The entire authed surface is **dormant** until a provider is configured. Every
authed endpoint returns `503 { "error": "offramp_disabled" }` in that state.
`GET /status` stays public so a client can decide whether to render the flow.

> **Auth**: `GET /status` is public. All other routes require an API key
> (`Bearer sk_live_...`) or a Supabase JWT.

## Status

`GET /api/v1/offramp/status`

```json
{
  "enabled": true,
  "provider": "etherfuse",
  "displayName": "Etherfuse",
  "currencies": ["BRL"],
  "rails": ["pix"],
  "capabilities": {
    "kycUrl": true,
    "kycFlow": "iframe",
    "deferredOffRampSigning": true
  }
}
```

When dormant:

```json
{ "enabled": false }
```

The `capabilities` object is provider-declared. Check it rather than assuming
KYC style, signing style, or fiat-account registration. Notable flags:
`kycUrl`, `kycFlow`, `deferredOffRampSigning`, `requiresBankBeforeQuote`,
`requiresBlockchainWalletRegistration`.

## Quote

`POST /api/v1/offramp/quote`

### Request

Provide either `fromAmount` or `toAmount`.

```json
{
  "fromCurrency": "USDC",
  "toCurrency": "BRL",
  "fromAmount": "100",
  "customerId": "c_123",
  "stellarAddress": "G...",
  "resourceId": "bank_acc_123"
}
```

| field | required | notes |
|---|---|---|
| `fromCurrency` | yes | e.g. `USDC` (off-ramp) or `BRL` (on-ramp) |
| `toCurrency` | yes | the other side of the pair |
| `fromAmount` | one of | decimal string |
| `toAmount` | one of | decimal string |
| `customerId` | no | some providers require it |
| `stellarAddress` | no | used by providers that resolve the wallet asset |
| `resourceId` | no | bank account / blockchain wallet id some providers need |

### Response

```json
{
  "quote": {
    "id": "q_123",
    "fromCurrency": "USDC",
    "toCurrency": "BRL",
    "fromAmount": "100",
    "toAmount": "524.4426",
    "exchangeRate": "5.40",
    "fee": "5.4",
    "expiresAt": "2026-10-19T18:34:00.000Z",
    "createdAt": "2026-10-19T18:24:00.000Z",
    "grossToAmount": "534.6",
    "platformFeeBps": 190,
    "platformFee": "10.1574"
  }
}
```

`applyMargin` embeds Slippay's spread into every quote, in both directions:

- `grossToAmount` — the provider's output before the spread;
- `toAmount` — the user's output after the spread;
- `platformFeeBps` — `SLIPPAY_RAMP_MARGIN_BPS`, default `190` (1.9%), capped at
  `1000`; out-of-range values fall back to 190;
- `platformFee` — the difference, decimal string.

Quotes expire. Create the order before `expiresAt`, and do not treat a quote as
a price guarantee after expiry.

## Create a customer

`POST /api/v1/offramp/customer`

```json
{
  "email": "user@example.com",
  "country": "BR",
  "publicKey": "G...",
  "name": "Maria Silva",
  "taxId": "12345678901",
  "taxIdCountry": "BRA"
}
```

All fields are optional at the schema level; each provider requires its own
subset (for example, Etherfuse uses the Stellar public key as the wallet
identity). Returns `{ "customer": { ... } }` with the provider's customer object,
including `id`, `kycStatus`, and timestamps.

## KYC

### Get the hosted KYC URL

`GET /api/v1/offramp/kyc-url?customerId=...&publicKey=...&bankAccountId=...`

`customerId` is required; the other two are provider-specific. Returns
`{ "url": "https://..." }` for an iframe/redirect flow. `501 unsupported` if the
provider does not expose a hosted KYC URL.

### Check KYC status

`GET /api/v1/offramp/customer/:id/kyc?publicKey=...`

```json
{ "status": "approved" }
```

Status is one of `pending`, `approved`, `rejected`, `not_started`,
`update_required`.

### List fiat accounts

`GET /api/v1/offramp/customer/:id/fiat-accounts`

```json
{ "accounts": [ { "id": "acc_123", "type": "pix", "label": "..." } ] }
```

## Create an off-ramp order (sell)

`POST /api/v1/offramp/order`

### Request

```json
{
  "customerId": "c_123",
  "quoteId": "q_123",
  "stellarAddress": "G...",
  "fromCurrency": "USDC",
  "toCurrency": "BRL",
  "amount": "100",
  "fiatAccountId": "acc_123",
  "memo": "optional"
}
```

| field | required | notes |
|---|---|---|
| `customerId` | yes | customer created above |
| `quoteId` | yes | unexpired quote |
| `stellarAddress` | yes | wallet sending the crypto |
| `fromCurrency` / `toCurrency` | yes | e.g. `USDC` → `BRL` |
| `amount` | yes | decimal string in `fromCurrency` |
| `fiatAccountId` | yes | registered payout account |
| `memo` | no | provider-specific |

### Response

`201 Created`

```json
{
  "order": {
    "id": "ord_123",
    "status": "pending",
    "fromAmount": "100",
    "toAmount": "524.4426",
    "createdAt": "2026-10-19T18:24:00.000Z",
    "updatedAt": "2026-10-19T18:24:00.000Z"
  }
}
```

The exact `order` shape is the provider's `OffRampTransaction` mapping. Fields
that matter operationally are `id`, `status`, and — when
`capabilities.deferredOffRampSigning` is true — `signableTransaction`.

Etherfuse does **not** return the burn XDR in the creation response. Its create
call returns `signableTransaction: undefined` (omitted from JSON); poll
`GET /order/:id` until the field appears, then sign and submit it.

## Fetch an off-ramp order

`GET /api/v1/offramp/order/:id`

```json
{ "order": { "id": "ord_123", "status": "completed" } }
```

`404 not_found` when the provider has no such transaction.

## Create an on-ramp order (buy)

`POST /api/v1/offramp/onramp`

```json
{
  "customerId": "c_123",
  "quoteId": "q_123",
  "stellarAddress": "G...",
  "fromCurrency": "BRL",
  "toCurrency": "USDC",
  "amount": "100",
  "memo": "optional",
  "bankAccountId": "acc_123",
  "identity": {
    "name": "Maria Silva",
    "email": "user@example.com",
    "taxId": "12345678901",
    "taxIdCountry": "BRA",
    "birthDate": "01/01/1990"
  }
}
```

`identity` is required by charge-model providers (CriptoPix) that need inline
payer identity. Returns `201 { "order": { ... } }`. When the provider returns
payment instructions, render them to the payer — for Pix the useful field is
`order.paymentInstructions.pixCode` (the copy-paste BR Code).

## Fetch an on-ramp order

`GET /api/v1/offramp/onramp/:id`

```json
{ "order": { "id": "ord_123", "status": "completed" } }
```

## List rampable assets (diagnostic)

`GET /api/v1/offramp/assets?blockchain=stellar&currency=brl&wallet=G...`

Confirms which asset identifier the provider returns for the corridor — for
example the Stellar USDC issuer. `501 unsupported` if the provider does not
expose the call.

## Asynchronous status and signing

The ramp surface is asynchronous. A successful create does not mean the money
has moved.

**Off-ramp (deferred signing).** When the provider returns a
`signableTransaction`, the order is not final:

1. Decode the transaction and verify its recipient, asset and amount against
   what the user approved. Do not sign an opaque XDR.
2. Have the user's passkey wallet sign it.
3. Submit it through the relayer flow (or the provider's required path, when
   `requiresAnchorPayoutSubmission` is set).
4. Poll `GET /order/:id` until a terminal status is reached.

With Etherfuse the XDR is not in the create response. Poll `GET /order/:id`
until `signableTransaction` is present before attempting step 1. If it never
appears, the order stays pending and must not be treated as signable.

**Status transport.** For providers with a normal read endpoint (Etherfuse), the
GET polls the provider. For charge-model providers (CriptoPix), status is
delivered by webhook into `ramp_transactions` — see
[Ramp webhooks](./ramp.md) — and the GET resolves against that store. Do not
poll the provider directly for those.

**Canonical statuses.** `pending`, `processing`, `completed`, `failed`,
`expired`, `cancelled`, `refunded`. A provider may return its own string; treat
unknown values as non-terminal and continue polling.

### Receiver pinning

The receiver on a sell is the address the user's funds are sent to; a malicious
or compromised provider response could redirect the money. Slippay therefore
pins it:

- **4P off-ramp** — `POST /api/v1/4p/offramp` compares the provider-returned
  `receiver_wallet` with `FOURP_OFFRAMP_RECEIVER` and rejects a mismatch with
  `502 receiver_mismatch` **before** returning anything signable. The web client
  separately asserts the same address (`VITE_4P_OFFRAMP_RECEIVER`) before
  signing. The check fails closed: if the pin is configured and the values
  differ, the flow stops. See [4P Finance](./fourp.md#receiver-pinning).
- **Etherfuse** — the flow returns a signable transaction rather than a receiver
  string. Apply the same rule at the signing boundary: decode, assert the
  recipient is the expected provider/payout address, then sign. If it differs,
  refuse.

A caller must treat a receiver mismatch as a hard failure, not a warning. There
is no "continue anyway" path.

## End-to-end flow

An off-ramp integration, in order:

1. `GET /status` — if `enabled` is false, do not render the flow.
2. `POST /customer` with the wallet identity — store the returned `id`.
3. `GET /kyc-url?customerId=...` — open the hosted KYC; poll
   `GET /customer/:id/kyc` until `approved`.
4. `GET /customer/:id/fiat-accounts` — pick the payout account.
5. `POST /quote` — show `toAmount`, `platformFee` and `expiresAt`.
6. `POST /order` — create the sell with the quote and account.
7. Poll `GET /order/:id` until `signableTransaction` is present; decode it,
   verify recipient/asset/amount, sign with the passkey wallet, submit via the
   relayer, then keep polling until a terminal status.

For an on-ramp, replace steps 4 and 6–7 with: `POST /onramp` (with inline
`identity` when the provider requires it), render
`order.paymentInstructions.pixCode`, then poll `GET /onramp/:id`.

## Errors

Provider errors are mapped as follows:

| status | code | when |
|---|---|---|
| 400 | `validation_error` | zod failed; `issues` present |
| 400 | `missing_customer_id` | `kyc-url` called without `customerId` |
| 401 | `unauthenticated` | missing/invalid API key or JWT |
| 404 | `not_found` | no such order/transaction |
| 501 | `unsupported` | provider does not implement the optional call |
| 503 | `offramp_disabled` | no provider configured |
| 4xx/5xx | provider code | an `AnchorError` is returned with its upstream code and status (or 502 if the status is invalid) |
| 502 | `offramp_error` | an unexpected error; details are not leaked |

## Activation

Provider precedence in `lib/ramp/index.ts`:

1. **CriptoPix** when `CRIPTOPIX_ENABLED=1` and `CRIPTOPIX_CLIENT_ID`,
   `CRIPTOPIX_CLIENT_SECRET`, `CRIPTOPIX_BASE_URL` are all set;
2. otherwise **Etherfuse** when `ETHERFUSE_ENABLED=1` and `ETHERFUSE_API_KEY`
   are set;
3. otherwise dormant.

Optional Etherfuse settings: `ETHERFUSE_BASE_URL` (default
`https://api.sand.etherfuse.com`) and `ETHERFUSE_BLOCKCHAIN` (default
`stellar`). Quotes carry the Slippay margin controlled by
`SLIPPAY_RAMP_MARGIN_BPS`.

For the 4P-specific Pix flow, use [4P Finance](./fourp.md); it does not go
through the `Anchor` interface.

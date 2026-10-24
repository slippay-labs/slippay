# Relayer

The gas-sponsor relayer for the biometric (passkey) payment flow. A Soroban
transaction needs a classic account as its source to pay the network fee; a
passkey smart-wallet is a contract and cannot be that source. The relayer is the
sponsor account that signs the outer envelope and pays gas.

It is **non-custodial over user funds**. The relayer's key pays gas only. The
user's money lives in their passkey smart-wallet and moves only when the
on-chain `__check_auth` verifies a real WebAuthn assertion carried in the
transaction. The relayer never authorizes a transfer.

> **Auth**: none. The payer side has no API key. Every route is per-IP
> rate-limited at 12 requests burst / 0.1 per second.

## Get relayer info

`GET /api/v1/relayer/info`

The browser needs the sponsor public key (to set as the transaction source), the
network, and the wallet wasm hash.

```json
{
  "sponsor": "G...",
  "network": "TESTNET",
  "rpc": "https://soroban-testnet.stellar.org",
  "wasm_hash": "abcdef...",
  "amount_cap": "5000000"
}
```

| field | notes |
|---|---|
| `sponsor` | sponsor public key; use as the transaction source |
| `network` | `TESTNET` or `PUBLIC` |
| `rpc` | Soroban RPC URL the relayer uses |
| `wasm_hash` | allowed smart-wallet wasm hash, or `null` if unset |
| `amount_cap` | per-payment ceiling in stroops |

`503 relayer_not_configured` when the sponsor secret is absent. Deploying the
route before funding the sponsor is safe.

## Deploy a passkey wallet

`POST /api/v1/relayer/deploy`

The relayer builds and signs this transaction itself, so no caller XDR is
accepted. It deploys a smart-wallet bound to the passkey and fronts a small
demo float into it. Only the bounded deploy fee and float are spent.

### Request

```json
{
  "passkey_pubkey_hex": "04...",
  "cred_id_hex": "a1b2..."
}
```

| field | required | notes |
|---|---|---|
| `passkey_pubkey_hex` | yes | 65-byte uncompressed P-256 point, starting with `04` |
| `cred_id_hex` | yes | WebAuthn credential id, hex-encoded |

### Response

`200 OK`

```json
{
  "wallet_id": "C...",
  "funded": "2000000"
}
```

| field | notes |
|---|---|
| `wallet_id` | deployed contract address |
| `funded` | demo float in stroops (`RELAYER_FUND_AMOUNT`, default 0.2 XLM) |

### Errors

| status | code | when |
|---|---|---|
| 400 | `bad_json` | body is not JSON |
| 400 | `missing_passkey_fields` | a required field is absent |
| 400 | `bad_hex` | a field is not valid hex |
| 400 | `bad_passkey_pubkey` | public key is not 65 bytes or lacks the `04` prefix |
| 502 | `deploy_failed` | simulation, submit or settlement failed |
| 502 | `fund_failed` | deploy succeeded but the float transfer failed |
| 503 | `relayer_not_configured` | sponsor secret absent |
| 503 | `wasm_hash_not_configured` | `RELAYER_WASM_HASH` absent |

## Submit a sponsored transaction

`POST /api/v1/relayer/submit`

The browser builds the unsigned transaction with the sponsor as source and the
passkey auth entry attached, then posts the XDR. The relayer validates it,
signs the envelope, submits, and polls to settlement.

### Request

```json
{ "xdr": "AAAAAgAAA..." }
```

### Validation (fail-closed)

A transaction is sponsored only if **all** of these hold:

- it is a plain transaction, not a fee-bump;
- `source` is the relayer sponsor;
- the network fee is at most `RELAYER_FEE_CAP` (default 2 XLM);
- it has exactly one operation;
- that operation is `invokeHostFunction`, and is either:
  - a contract deploy whose wasm hash equals `RELAYER_WASM_HASH`; or
  - a SAC `transfer` whose `from` argument is a **contract** address (a
    passkey wallet), with a positive `i128` amount at most
    `RELAYER_AMOUNT_CAP` (default 0.5 XLM).

Anything else is rejected before signing.

### Response

`200 OK`

```json
{ "hash": "20655a78..." }
```

`hash` is the settled Stellar transaction hash. Settlement is polled for up to
30 seconds.

### Errors

| status | code | when |
|---|---|---|
| 400 | `bad_json` / `missing_xdr` | invalid request body |
| 403 | `rejected` | validation failed; `reason` names the failed rule |
| 502 | `send_error` | the network rejected the transaction |
| 502 | `send_failed` | transport error while submitting |
| 502 | `not_confirmed` | not settled before polling timed out; includes `status` and `hash` |
| 503 | `relayer_not_configured` | sponsor secret absent |

Rejection reasons include `fee_bump_not_accepted`, `source_not_sponsor`,
`fee_over_cap`, `must_be_single_op`, `not_invoke_host_function`,
`wrong_wasm_hash`, `from_not_contract`, `amount_not_i128`,
`amount_over_cap`, `amount_not_positive`, and parse errors.

## Limits and configuration

| variable | default | meaning |
|---|---|---|
| `RELAYER_NETWORK` / `STELLAR_NETWORK` | `testnet` | network selection |
| `RELAYER_RPC` | network default | Soroban RPC endpoint |
| `RELAYER_SECRET` | — | sponsor secret (small gas float, never user funds) |
| `RELAYER_WASM_HASH` | — | only smart-wallet wasm the relayer will deploy |
| `RELAYER_AMOUNT_CAP` | `5000000` stroops (0.5 XLM) | per-transfer ceiling |
| `RELAYER_FEE_CAP` | `20000000` stroops (2 XLM) | max fee per transaction |
| `RELAYER_FUND_AMOUNT` | `2000000` stroops (0.2 XLM) | demo float on deploy |
| `RELAYER_MAX_ABS` | `1000000000` | wallet constructor absolute per-charge ceiling |

The relayer's worst-case abuse is wasted gas, not stolen funds, bounded by the
single-operation, source, wasm-hash, amount and fee checks above.

For the full biometric flow, see [Biometric pay](../guides/biometric-pay.md).

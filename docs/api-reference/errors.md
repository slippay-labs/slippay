# Errors

SlipPay returns errors as JSON with consistent shape:

```json
{
  "error": "validation_error",
  "detail": "brl_amount: must be string with 2 decimals",
  "issues": [ ... ]
}
```

| field | type | when present |
|---|---|---|
| `error` | string | always; machine-readable code |
| `detail` | string | optional; human-readable explanation |
| `issues` | array | only on `validation_error`; per-field zod issues |

## Status code conventions

| status | meaning |
|---|---|
| 2xx | success |
| 400 | malformed request, validation failure, business-rule violation |
| 401 | missing or invalid credentials |
| 403 | authenticated but forbidden from the resource |
| 404 | resource not found OR you don't have permission to see it (no leak) |
| 409 | resource state conflicts with the action (e.g., charge after cancel) |
| 422 | semantic error in input that schema didn't catch |
| 501 | the integration behind this route is not configured on this deployment; **not** retryable |
| 5xx | SlipPay broke; safe to retry with backoff (except `501`) |

## Common error codes

### Authentication

| status | code | meaning |
|---|---|---|
| 401 | `missing_authorization` | no `Authorization` header |
| 401 | `invalid_api_key` | API key doesn't match any merchant |
| 401 | `invalid_jwt` | JWT signature failed or expired |
| 403 | `forbidden` | wrong owner |

### Validation

| status | code | meaning |
|---|---|---|
| 400 | `validation_error` | zod failed; see `issues` for details |
| 400 | `empty_update` | PATCH body had no editable fields |

### Orders

| status | code | meaning |
|---|---|---|
| 400 | `create_failed` | DB insert error; `detail` has the message |
| 400 | `cannot_cancel` | order is not in `pending` state |
| 404 | `not_found` | order doesn't exist or doesn't belong to you |

### Subscriptions

| status | code | meaning |
|---|---|---|
| 404 | `not_found` | subscription doesn't exist or wrong owner |
| 409 | `not_active` | status is paused, cancelled, or expired |
| 409 | `expired` | expires_at has passed |
| 409 | `max_periods_reached` | charges_done >= max_periods |
| 400 | `order_create_failed` | charge failed to materialize order; `detail` has message |
| 400 | `cannot_cancel` | already cancelled |

### Merchants

| status | code | meaning |
|---|---|---|
| 400 | `create_failed` | DB insert failed (likely duplicate auth_user_id) |
| 400 | `update_failed` | PATCH failed |
| 400 | `rotate_failed` | key rotation failed |
| 404 | `not_found` | no merchant for this auth user |

### Ramps (4P on-ramp / off-ramp, `/v1/4p/*`)

A dormant integration and a provider outage are different conditions and carry
different status codes. Clients must branch on the status (or the `error` code),
not treat every 5xx the same:

| status | code | meaning | retry? |
|---|---|---|---|
| 501 | `ramp_disabled` | the 4P integration is not configured on this deployment (`FOURP_API_KEY` unset). Permanent until it is turned on. | no |
| 502 | `fourp_error` | 4P answered with an error or was unreachable; `message` carries 4P's reason | yes |
| 502 | `ramp_error` | an unexpected server-side failure while talking to 4P | yes |
| 502 | `receiver_mismatch` | 4P returned a receiver wallet that did not match `FOURP_OFFRAMP_RECEIVER`; nothing was signed | no |
| 404 | `not_found` | the ramp order id is unknown to the store | no |

`GET /v1/4p/status` always answers `200` with `{ "enabled": false }` while the
integration is dormant, so a client can probe availability without reading an
error. `503` is never used to mean "disabled" — a `502`/`503` from a ramp route
is a transient upstream condition and the caller should retry rather than
latching "ramp not available".

The same split applies to the Etherfuse off-ramp route (`/v1/offramp/*`), which
returns `503 offramp_disabled` while dormant; that code is still `503` for
backwards compatibility and is distinguishable by its `error` value.

## Retry guidance

| status | retry? |
|---|---|
| 4xx | no — the request is wrong; fix and retry manually |
| 501 | no — the feature is not configured on this deployment; retrying will not help |
| other 5xx | yes — exponential backoff, max 5 attempts |
| network error / timeout | yes — but be careful about idempotency (orders are not idempotent on POST; use the `subscription.charge` idempotency contract for recurring) |

## Validation issue shape

When `error` is `validation_error`, `issues` contains zod's per-field errors:

```json
{
  "error": "validation_error",
  "issues": [
    {
      "path": ["brl_amount"],
      "code": "invalid_string",
      "message": "must be string with 2 decimals"
    },
    {
      "path": ["period_seconds"],
      "code": "too_small",
      "message": "Number must be greater than or equal to 86400"
    }
  ]
}
```

Use `issues[i].path` to map back to your form fields.

## Reporting bugs

If you hit an error code that's not documented here, or a 5xx with no
useful detail, file an issue at
[github.com/Galmanus/slippay/issues](https://github.com/Galmanus/slippay/issues)
with:

- the request you sent (sanitize the API key)
- the response body and status
- timestamp (so we can find the request in server logs)

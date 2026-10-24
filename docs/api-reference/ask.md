# Ask Slippay

The concierge behind the landing-page chat widget. It answers questions about
SlipPay from the documentation corpus and streams the answer as Server-Sent
Events. It is not a general-purpose merchant API.

> **Auth**: none, but the route is **origin-gated** and rate-limited. It is
> intended for browsers on an allowlisted Slippay origin.

## Ask a question

`POST /api/v1/ask`

The handler spawns a short-lived Claude CLI subprocess per request. Capacity is
deliberately small; this is a public concierge, not an inference API.

### Request

```json
{
  "question": "How do I create an order?",
  "history": [
    { "role": "user", "content": "What is SlipPay?" },
    { "role": "assistant", "content": "SlipPay settles dollars over Stellar." }
  ]
}
```

| field | type | required | notes |
|---|---|---|---|
| `question` | string | yes | 1–4000 characters after trimming |
| `history` | array | no | max 10 most recent turns are used; each turn is `{ role, content }` with `role` = `user` or `assistant` |

History turns with another role, or with a non-string `content`, are dropped.
The total forwarded prompt (question + history) is hard-capped at 24,000
characters.

### Origin gate

At least one of `Origin` or `Referer` must be present, and its origin must be on
the allowlist. Browsers send these automatically on cross-origin POSTs. A
header-less server-to-server call is rejected by design:

```sh
curl -N https://api.slippay.cc/api/v1/ask \
  -H "Origin: https://app.slippay.cc" \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I create an order?"}'
```

The CORS allowlist in `index.ts` is advisory; this gate is the enforcement.

### Response

`200 OK` with `Content-Type: text/event-stream`. Each frame is a JSON object on
a `data:` line:

```text
data: {"type":"text","text":"To create an order, "}

data: {"type":"text","text":"POST /api/v1/orders with brl_amount."}

data: {"type":"usage","usage":{"output_tokens":42}}

data: {"type":"done"}
```

| event type | payload | notes |
|---|---|---|
| `text` | `{ "text": string }` | answer delta; concatenate in order |
| `usage` | `{ "usage": object }` | provider token-usage hint, when emitted |
| `error` | `{ "error": string }` | fatal error; stream then closes |
| `done` | — | normal end of stream |

Citations are inline `[docs/...]` markers inside the streamed text; the frontend
extracts them. There is no separate `citation` event.

### Errors

| status | code | when |
|---|---|---|
| 400 | `invalid_json` | body is not JSON |
| 400 | `invalid_question` | empty question or longer than 4000 chars |
| 403 | `origin_required` | neither `Origin` nor `Referer` was sent |
| 403 | `origin_not_allowed` | origin is malformed or not allowlisted |
| 429 | `daily_limit_reached` | process-wide daily spawn cap reached |
| 429 | `rate_limited` | per-IP request bucket exhausted |
| 500 | `stream_failed` | the engine failed before the SSE stream was returned |
| 503 | `busy` | more than 4 requests already in flight |
| 503 | `service_unavailable` | the Claude engine is not configured |

## Limits

| limit | value |
|---|---|
| per-IP sustained | 5 requests/minute (burst 5) |
| per-IP daily-ish | 100 requests/day (refill 100 per 86,400 s) |
| concurrent subprocesses | 4 process-wide |
| daily subprocess spawns | 500 per UTC day (`ASK_MAX_SPAWNS_PER_DAY`) |
| question length | 4000 characters |

The global `/api/*` bucket also applies. When the daily cap is hit the response
includes `retry-after: 3600`.

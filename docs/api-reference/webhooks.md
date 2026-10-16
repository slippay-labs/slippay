# Webhooks

SlipPay POSTs JSON events to your `webhook_url` whenever the state of an
order or subscription changes. Events are signed with HMAC-SHA256 and
retried with exponential backoff until they succeed or are marked dead.

## Event types

| event | when |
|---|---|
| `order.paid` | listener confirmed an on-chain payment matching a one-shot order |
| `order.underpaid` | payment landed but amount below expected |
| `order.expired` | order's expires_at passed without payment (pg_cron) |
| `order.cancelled` | merchant called POST /:id/cancel |
| `subscription.charged` | listener confirmed a payment for an order originating from a subscription |
| `subscription.cancelled` | merchant cancelled the subscription |
| `subscription.expired` | charges_done >= max_periods OR expires_at reached |

> The first time a charge succeeds for a subscription order, the event fires
> as `subscription.charged` (not `order.paid`), so handlers don't need to
> dedup. If you only handle one-shot orders, listen to `order.paid`.

## Payload shape

All events share this envelope:

```json
{
  "type": "order.paid",
  "data": {
    "id": "ord_3f1a8c4d-...",
    "subscription_id": null,
    "external_ref": "cart_42",
    "brl_amount": "99.90",
    "usdc_amount": "18.16",
    "tx_hash": "20655a78f270de139fed0cbc70b37e663253ca2723f957edc27966b56c21ba5c",
    "memo": "ce230c1913a3668164c8544ac49fd244fba452b19ddee02425386945a5e85cd2",
    "paid_at": "2026-05-10T14:00:06Z"
  }
}
```

### Per-event `data` fields

#### `order.paid` / `subscription.charged`

| field | type | notes |
|---|---|---|
| `id` | uuid | the order id |
| `subscription_id` | uuid \| null | populated only on subscription.charged |
| `external_ref` | string \| null | what you set when creating the order/sub |
| `brl_amount` | string | invoice amount |
| `usdc_amount` | string | settlement amount on Stellar |
| `tx_hash` | string | Stellar transaction hash (verifiable on stellar.expert) |
| `memo` | string | 64-hex-char memo that routed the payment |
| `paid_at` | iso8601 | when the listener marked it paid |

#### `order.underpaid`

Same as above plus:

| field | type | notes |
|---|---|---|
| `expected` | string | expected merchant share (after platform fee) |
| `received` | string | actual amount received on-chain |

#### `order.expired` / `order.cancelled`

| field | type |
|---|---|
| `id` | uuid |
| `external_ref` | string \| null |

## Delivery guarantees

- **At-least-once**: an event may be delivered multiple times. Use
  `data.id` (or `data.tx_hash` for paid events) as your idempotency key.
- **Order is not guaranteed**: a `subscription.charged` for cycle 7 may
  arrive before cycle 6 if cycle 6's webhook is still retrying. Use
  `paid_at` to reconstruct order if needed.
- **Body is the source of truth**, not query strings or headers (other than
  the signature).

## Retry schedule

If your endpoint returns anything other than `2xx`, SlipPay retries:

| attempt | delay from previous |
|---|---|
| 1 | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 12 hours |
| 7 | 24 hours |
| 8 | dead — manual replay required |

A single retry timeout is **15 seconds**. Endpoints that take longer than
that should `2xx`-ack first and process the event asynchronously.

## SSRF protection

SlipPay refuses to deliver to localhost, RFC1918 private ranges, link-local,
and IPv6 ULA. See `apps/listener/src/ssrf.ts`. If your webhook URL fails
SSRF check, the delivery is marked `dead` immediately and never attempted.

## Headers and delivery contract

Every webhook request emitted by SlipPay includes the following security and delivery headers:

| Header | Description | Example |
|---|---|---|
| `x-slippay-signature` | Timestamped signature header formatted as `t=<timestamp>,v1=<hex_hmac>` | `t=1778430000,v1=6fda9c0f8e7b2a1c3d4e5f6789a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8` |
| `x-slippay-delivery-id` | Unique UUID for this delivery attempt | `7b235e12-4f3b-4822-b5e2-63b72c918c44` |
| `content-type` | Content type of payload | `application/json` |

### Deduplication contract

SlipPay operates an **at-least-once** delivery model. Receivers must guard against duplicate deliveries:
1. **Delivery-level deduplication**: Use `x-slippay-delivery-id` to identify redeliveries of the same webhook attempt (e.g. if an earlier response timed out on the wire). If the delivery ID was already acknowledged, respond with HTTP `200 OK` immediately.
2. **Business-level idempotency**: Store processed `data.id` (order UUID) or `data.tx_hash` (on-chain transaction hash). Multiple webhooks may reference the same paid order; processing must be idempotent.

## Retry and backoff schedule

SlipPay’s webhook dispatcher executes bounded retries with exponential backoff:

| Attempt | Backoff delay from previous attempt | Approximate cumulative elapsed time |
|---|---|---|
| 1 | Immediate | 0 |
| 2 | 60 seconds (1 minute) | ~1 min |
| 3 | 300 seconds (5 minutes) | ~6 min |
| 4 | 1,800 seconds (30 minutes) | ~36 min |
| 5 | 7,200 seconds (2 hours) | ~2.5 hours |
| 6 | 43,200 seconds (12 hours) | ~14.5 hours |
| 7 | 86,400 seconds (24 hours) | ~38.5 hours |
| > 7 | Dead-lettered (status: `dead`) | No further retries |

### Critical retry rules

- **4xx Fail-Closed Policy**: If your endpoint returns an HTTP `4xx` client error (e.g., `400 Bad Request`, `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity`), the delivery is classified as permanently rejected and **immediately marked as `dead`**. It will **not** be retried.
- **5xx and Network Errors**: Server errors (`5xx`) or connection timeouts are retried according to the schedule above.
- **Request Timeout**: Each webhook delivery attempt has a hard timeout of **10 seconds**. Receivers should acknowledge `200 OK` promptly and process asynchronous work in the background.

## Webhook signature verification

The signature is computed over the string `"${t}.${raw_body}"` using your merchant `webhook_secret` with HMAC-SHA256.

### Specification

1. **Header Format**: `x-slippay-signature` contains comma-separated key-value pairs: `t=<timestamp_in_seconds>,v1=<hex_encoded_signature>`.
2. **Canonical String to Sign**: Concatenate the timestamp string `t`, a literal dot `.`, and the exact UTF-8 raw request body bytes:
   ```
   message = `${t}.${raw_body}`
   ```
3. **Tolerance Window**: Assert that `Math.abs(currentTime - t) <= 300` (5 minutes). Rejects timestamps older than 5 minutes or in the far future to prevent replay attacks.
4. **Timing-Safe Comparison**: Always verify the signature using a constant-time comparison function (e.g. `crypto.timingSafeEqual` or `hash_equals`) to prevent timing side-channel attacks.

> **CRITICAL**: Always read the **raw body** bytes before parsing JSON. Re-serializing parsed JSON alters whitespace and key ordering, which breaks HMAC verification.

### Reference implementation (Node.js / TypeScript)

```ts
import crypto from "node:crypto";

export function verifySlippayWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300,
): boolean {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map(p => {
      const idx = p.indexOf("=");
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
    }),
  );

  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) {
    return false; // Stale timestamp or clock skew > 5 minutes
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const toSign = `${t}.${payload}`;
  const expectedHex = crypto.createHmac("sha256", secret).update(toSign).digest("hex");

  if (expectedHex.length !== v1.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(v1, "utf8"));
}
```

### Reference implementation (Python 3)

```python
import hmac
import hashlib
import time

def verify_slippay_webhook(
    raw_body: bytes,
    signature_header: str,
    secret: str,
    tolerance_seconds: int = 300,
) -> bool:
    if not signature_header or not secret:
        return False

    parts = dict(pair.split("=", 1) for pair in signature_header.split(",") if "=" in pair)
    t_str = parts.get("t")
    v1 = parts.get("v1")
    if not t_str or not v1:
        return False

    try:
        t = int(t_str)
    except ValueError:
        return False

    now = int(time.time())
    if abs(now - t) > tolerance_seconds:
        return False  # Replay prevention

    to_sign = f"{t}.".encode("utf-8") + raw_body
    expected_hex = hmac.new(secret.encode("utf-8"), to_sign, hashlib.sha256).hexdigest()

    return hmac.compare_digest(expected_hex, v1)
```

### Reference implementation (PHP 8+)

```php
function verifySlippayWebhook(
    string $rawBody,
    string $signatureHeader,
    string $secret,
    int $toleranceSeconds = 300
): bool {
    if (empty($signatureHeader) || empty($secret)) {
        return false;
    }

    $parts = [];
    foreach (explode(',', $signatureHeader) as $item) {
        $kv = explode('=', $item, 2);
        if (count($kv) === 2) {
            $parts[trim($kv[0])] = trim($kv[1]);
        }
    }

    if (!isset($parts['t'], $parts['v1']) || !is_numeric($parts['t'])) {
        return false;
    }

    $t = (int) $parts['t'];
    $v1 = $parts['v1'];

    if (abs(time() - $t) > $toleranceSeconds) {
        return false; // Timestamp out of tolerance
    }

    $toSign = $t . '.' . $rawBody;
    $expectedHex = hash_hmac('sha256', $toSign, $secret);

    return hash_equals($expectedHex, $v1);
}
```

### Sample Express Receiver

```ts
import express from "express";
import { verifySlippayWebhook } from "./verifySlippayWebhook.js";

const app = express();

// Capture raw bytes as a Buffer
app.use("/webhooks/slippay", express.raw({ type: "application/json" }));

app.post("/webhooks/slippay", async (req, res) => {
  const sig = req.header("x-slippay-signature") ?? "";
  const deliveryId = req.header("x-slippay-delivery-id") ?? "";
  const secret = process.env.SLIPPAY_WEBHOOK_SECRET!;

  // 1. Verify signature over raw bytes
  if (!verifySlippayWebhook(req.body, sig, secret)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  // 2. Delivery deduplication
  if (await isDeliveryAlreadyHandled(deliveryId)) {
    return res.status(200).json({ ok: true, note: "duplicate_delivery_ack" });
  }

  const event = JSON.parse(req.body.toString("utf8"));

  // 3. Process business event idempotently
  if (event.type === "order.paid") {
    await markOrderFulfilled(event.data.id, event.data.tx_hash);
  }

  return res.status(200).json({ ok: true });
});
```

## Testing webhooks

For local development, expose your local server with a tunnel:

```sh
# ngrok or cloudflared
ngrok http 3000
# -> https://abc123.ngrok.io
```

Set the resulting URL on your merchant's `webhook_url`. Trigger a payment on
testnet and watch the requests land.

## Replay / debug

Webhook deliveries are stored in the `webhook_deliveries` Postgres table.
The dashboard exposes per-delivery status and the last error message. Manual
replay is on the v0.2 roadmap; for now, trigger another payment to retry.

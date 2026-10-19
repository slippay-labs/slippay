// SlipPay × VTXX — Payment Provider Protocol connector.
//
// Implements the core VTX PPP endpoints and maps them onto SlipPay's public
// API (POST /api/v1/orders → checkout_url; SlipPay webhook → VTX callbackUrl).
// Same motor as the WooCommerce plugin, different platform — this is the
// "scale" proof: adding a platform is an adapter, not a rebuild.
//
// Scope: a WORKING connector that proves the mapping end-to-end against the
// live SlipPay backend. NOT VTEX-homologated (the mandatory test suite +
// homologation is post-Rio). createPayment + status callback are real;
// cancel/settle/refund return protocol-valid responses (scaffold).
//
// Run: SLIPPAY_API_KEY=sk_live_... node src/index.mjs   (node 18+, zero deps)

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4000);
const SLIPPAY_API_BASE = process.env.SLIPPAY_API_BASE ?? "https://api.slippay.cc";
// Per-merchant key normally comes from VTXX `merchantSettings`; env is the
// fallback used for local/standalone testing.
const FALLBACK_KEY = process.env.SLIPPAY_API_KEY ?? "";

// Shared order expiry bounds. The default and its schema bound live in one
// module so they cannot drift apart. This mirrors packages/shared/src/schemas/
// order.ts (z.number().int().min(5).max(1440)).
// TODO: import from the shared package once the connector is bundled with it.
export const ORDER_DEFAULT_EXPIRY_MINUTES = 60;
export const ORDER_EXPIRY_MIN_MINUTES = 5;
export const ORDER_EXPIRY_MAX_MINUTES = 1440;

// Validate the resolved value (after defaulting), not the raw input.
// Defaults bypass input validation by construction, so the default must be
// subject to the same bound as user input.
function resolveExpiryMinutes(input) {
  const minutes = input ?? ORDER_DEFAULT_EXPIRY_MINUTES;
  if (typeof minutes !== "number" || !integer(minutes)) {
    throw new Error(`expires_in_minutes must be an integer, got ${JSON.stringify(minutes)}`);
  }
  if (minutes < ORDER_EXPIRY_MIN_MINUTES || minutes > ORDER_EXPIRY_MAX_MINUTES) {
    throw new Error(
      `expires_in_minutes must be between ${ORDER_EXPIRY_MIN_MINUTES} and ${ORDER_EXPIRY_MAX_MINUTES}, got ${minutes}`,
    );
  }
  return minutes;
}

function integer(n) {
  return Number.isInteger(n);
}

// Compute and assert the resulting expiry is in the future and within the
// documented maximum window before it flows into the persisted `expires_at`
// and the signed checkout token.
function computeExpiryAt(minutes, now = Date.now()) {
  const expiresAt = new Date(now + minutes * 60_000);
  const maxAt = now + ORDER_EXPIRY_MAX_MINUTES * 60_000;
  if (!(expiresAt.getTime() > now)) {
    throw new Error(`expiresAt must be in the future, got ${expiresAt.toISOString()}`);
  }
  if (expiresAt.getTime() > maxAt) {
    throw new Error(
      `expiresAt exceeds maximum window of ${ORDER_EXPIRY_MAX_MINUTES} minutes, got ${expiresAt.toISOString()}`,
    );
  }
  return expiresAt;
}

// paymentId → { slippayOrderId, callbackUrl, status }. In-memory for the
// scaffold; production persists this (Supabase table) so callbacks survive
// restarts.
const payments = new Map();

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return {}; }
}

// VTEX → SlipPay: create an order, return its hosted checkout_url.
async function createSlippayOrder({ apiKey, value, reference, expiresInMinutes }) {
  // Validate the resolved value (after defaulting) and assert the
  // resulting expiry is in the future and within the documented maximum.
  const minutes = resolveExpiryMinutes(expiresInMinutes);
  const expiresAt = computeExpiryAt(minutes);

  const r = await fetch(`${SLIPPAY_API_BASE}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      brl_amount: Number(value).toFixed(2),
      reference,
      expires_in_minutes: minutes,
      expires_at: expiresAt.toISOString(),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`slippay ${r.status}: ${JSON.stringify(data)}`);
  return data; // { order: {...}, checkout_url }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 1. Manifest — declares the payment method VTXX will offer.
  if (req.method === "GET" && path === "/manifest") {
    return json(res, 200, {
      paymentMethods: [{ name: "SlipPay", allowsSplit: "disabled" }],
    });
  }

  // 2. Create Payment — idempotent. Maps to a SlipPay order + checkout_url.
  if (req.method === "POST" && path === "/payments") {
    const b = await readBody(req);
    const paymentId = b.paymentId ?? randomUUID();

    // Idempotency: same paymentId returns the same result.
    if (payments.has(paymentId)) {
      const p = payments.get(paymentId);
      return json(res, 200, { paymentId, status: p.status, tid: p.slippayOrderId, paymentUrl: p.checkoutUrl });
    }

    const apiKey = b.merchantSettings?.api_key || FALLBACK_KEY;
    if (!apiKey) return json(res, 200, { paymentId, status: "denied", message: "missing SlipPay api_key (merchantSettings)" });

    try {
      const { order, checkout_url } = await createSlippayOrder({
        apiKey,
        value: b.value,
        reference: paymentId,
        expiresInMinutes: b.expires_in_minutes,
      });
      payments.set(paymentId, {
        slippayOrderId: order.id, callbackUrl: b.callbackUrl, status: "undefined", checkoutUrl: checkout_url,
      });
      // status "undefined" = pending/async; VTXX redirects the buyer to
      // paymentUrl and waits for our callback to finalize.
      return json(res, 200, {
        paymentId, status: "undefined", tid: order.id,
        paymentUrl: checkout_url,
        message: `SlipPay order ${order.id} created (${order.brl_amount} BRL → ${order.usdc_amount} USDC)`,
      });
    } catch (e) {
      return json(res, 200, { paymentId, status: "denied", message: String(e.message ?? e) });
    }
  }

  // 3. SlipPay webhook → VTEX callback. When SlipPay confirms the order paid,
  //    notify VTXX so it finalizes the transaction.
  if (req.method === "POST" && path === "/slippay-webhook") {
    const b = await readBody(req);
    const orderId = b.order?.id ?? b.order_id ?? b.id;
    const paid = (b.event ?? b.order?.status) === "order.paid" || b.order?.status === "paid";
    const entry = [...payments.entries()].find(([, p]) => p.slippayOrderId === orderId);
    if (entry && paid && entry[1].callbackUrl) {
      const [paymentId, p] = entry;
      p.status = "approved";
      await fetch(p.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId, status: "approved", tid: p.slippayOrderId, authorizationId: p.slippayOrderId }),
      }).catch(() => {});
    }
    return json(res, 200, { received: true });
  }

  // 4-6. Cancel / Settle / Refund — protocol-valid scaffold responses.
  let m;
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/cancellations$/))) {
    return json(res, 200, { paymentId: m[1], cancellationId: randomUUID(), code: "cancel-manually", message: "non-custodial settlement; cancellation is informational" });
  }
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/settlements$/))) {
    const b = await readBody(req);
    return json(res, 200, { paymentId: m[1], settleId: randomUUID(), value: b.value, code: "settled-on-chain", message: "funds settle to merchant wallet on-chain at payment time" });
  }
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/refunds$/))) {
    const b = await readBody(req);
    return json(res, 200, { paymentId: m[1], refundId: randomUUID(), value: b.value, code: "refund-manually", message: "refunds handled off-protocol (non-custodial)" });
  }

  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, slippay: SLIPPAY_API_BASE });

  json(res, 404, { error: "not_found", path });
});

server.listen(PORT, () => {
  console.log(`SlipPay× VTXX connector on :${PORT} → ${SLIPPAY_API_BASE}`);
});

// SlipPay × VTEX — Payment Provider Protocol connector.
//
// Implements the core VTEX PPP endpoints and maps them onto SlipPay's public
// API (POST /api/v1/orders → checkout_url; SlipPay webhook → VTEX callbackUrl).
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

export const PORT = Number(process.env.PORT ?? 4000);
export const SLIPPAY_API_BASE = process.env.SLIPPAY_API_BASE ?? "https://api.slippay.cc";
// Per-merchant key normally comes from VTEX `merchantSettings`; env is the
// fallback used for local/standalone testing.
export const FALLBACK_KEY = process.env.SLIPPAY_API_KEY ?? "";

// paymentId → { slippayOrderId, callbackUrl, status, checkoutUrl }. In-memory for the
// scaffold; production persists this (Supabase table) so callbacks survive
// restarts.
export const payments = new Map();

export const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return {}; }
}

// VTEX → SlipPay: create an order, return its hosted checkout_url.
export async function createSlippayOrder({ apiKey, value, reference, apiBase = SLIPPAY_API_BASE }) {
  const r = await fetch(`${apiBase}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ brl_amount: Number(value).toFixed(2), reference }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`slippay ${r.status}: ${JSON.stringify(data)}`);
  return data; // { order: {...}, checkout_url }
}

export function getManifest() {
  return {
    paymentMethods: [{ name: "SlipPay", allowsSplit: "disabled" }],
  };
}

export async function handlePaymentCreate(b, { paymentsMap = payments, apiKeyFallback = FALLBACK_KEY, createOrderFn = createSlippayOrder } = {}) {
  const paymentId = b.paymentId ?? randomUUID();

  // Idempotency: same paymentId returns the same result.
  if (paymentsMap.has(paymentId)) {
    const p = paymentsMap.get(paymentId);
    return {
      status: 200,
      body: { paymentId, status: p.status, tid: p.slippayOrderId, paymentUrl: p.checkoutUrl },
    };
  }

  const apiKey = b.merchantSettings?.api_key || apiKeyFallback;
  if (!apiKey) {
    return {
      status: 200,
      body: { paymentId, status: "denied", message: "missing SlipPay api_key (merchantSettings)" },
    };
  }

  try {
    const { order, checkout_url } = await createOrderFn({
      apiKey, value: b.value, reference: paymentId,
    });
    paymentsMap.set(paymentId, {
      slippayOrderId: order.id, callbackUrl: b.callbackUrl, status: "undefined", checkoutUrl: checkout_url,
    });
    // status "undefined" = pending/async; VTEX redirects the buyer to
    // paymentUrl and waits for our callback to finalize.
    return {
      status: 200,
      body: {
        paymentId, status: "undefined", tid: order.id,
        paymentUrl: checkout_url,
        message: `SlipPay order ${order.id} created (${order.brl_amount} BRL → ${order.usdc_amount} USDC)`,
      },
    };
  } catch (e) {
    return {
      status: 200,
      body: { paymentId, status: "denied", message: String(e.message ?? e) },
    };
  }
}

export async function handleSlippayWebhook(b, { paymentsMap = payments, fetchFn = fetch } = {}) {
  const orderId = b.order?.id ?? b.order_id ?? b.id;
  const paid = (b.event ?? b.order?.status) === "order.paid" || b.order?.status === "paid";
  const entry = [...paymentsMap.entries()].find(([, p]) => p.slippayOrderId === orderId);
  if (entry && paid && entry[1].callbackUrl) {
    const [paymentId, p] = entry;
    p.status = "approved";
    await fetchFn(p.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId, status: "approved", tid: p.slippayOrderId, authorizationId: p.slippayOrderId }),
    }).catch(() => {});
  }
  return { status: 200, body: { received: true } };
}

export function handleCancellation(paymentId) {
  return { paymentId, cancellationId: randomUUID(), code: "cancel-manually", message: "non-custodial settlement; cancellation is informational" };
}

export function handleSettlement(paymentId, value) {
  return { paymentId, settleId: randomUUID(), value, code: "settled-on-chain", message: "funds settle to merchant wallet on-chain at payment time" };
}

export function handleRefund(paymentId, value) {
  return { paymentId, refundId: randomUUID(), value, code: "refund-manually", message: "refunds handled off-protocol (non-custodial)" };
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 1. Manifest — declares the payment method VTEX will offer.
  if (req.method === "GET" && path === "/manifest") {
    return json(res, 200, getManifest());
  }

  // 2. Create Payment — idempotent. Maps to a SlipPay order + checkout_url.
  if (req.method === "POST" && path === "/payments") {
    const b = await readBody(req);
    const result = await handlePaymentCreate(b);
    return json(res, result.status, result.body);
  }

  // 3. SlipPay webhook → VTEX callback.
  if (req.method === "POST" && path === "/slippay-webhook") {
    const b = await readBody(req);
    const result = await handleSlippayWebhook(b);
    return json(res, result.status, result.body);
  }

  // 4-6. Cancel / Settle / Refund — protocol-valid scaffold responses.
  let m;
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/cancellations$/))) {
    return json(res, 200, handleCancellation(m[1]));
  }
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/settlements$/))) {
    const b = await readBody(req);
    return json(res, 200, handleSettlement(m[1], b.value));
  }
  if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/refunds$/))) {
    const b = await readBody(req);
    return json(res, 200, handleRefund(m[1], b.value));
  }

  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, slippay: SLIPPAY_API_BASE });

  json(res, 404, { error: "not_found", path });
});

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("src/index.mjs")) {
  server.listen(PORT, () => {
    console.log(`SlipPay×VTEX connector on :${PORT} → ${SLIPPAY_API_BASE}`);
  });
}

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

/** Compute and validate formatted BRL price. Throws on NaN or negative/zero values. */
export function formatBrlAmount(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) {
    throw new Error(`invalid_amount: ${value}`);
  }
  return n.toFixed(2);
}

/** VTEX PPP request token / appKey verification helper.
 *  Checks X-VTEX-API-AppKey and X-VTEX-API-AppToken headers if configured. */
export function verifyVtexAuth(headers, expectedAppKey = process.env.VTEX_APP_KEY, expectedAppToken = process.env.VTEX_APP_TOKEN) {
  if (!expectedAppKey && !expectedAppToken) return true; // not configured
  const key = headers["x-vtex-api-appkey"] ?? headers["X-VTEX-API-AppKey"];
  const token = headers["x-vtex-api-apptoken"] ?? headers["X-VTEX-API-AppToken"];
  if (expectedAppKey && key !== expectedAppKey) return false;
  if (expectedAppToken && token !== expectedAppToken) return false;
  return true;
}

// VTEX → SlipPay: create an order, return its hosted checkout_url.
export async function createSlippayOrder({ apiKey, value, reference, apiBase = SLIPPAY_API_BASE, fetchImpl = fetch }) {
  const brl_amount = formatBrlAmount(value);
  const r = await fetchImpl(`${apiBase}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ brl_amount, reference }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`slippay ${r.status}: ${JSON.stringify(data)}`);
  return data; // { order: {...}, checkout_url }
}

export function createRequestHandler(opts = {}) {
  const apiBase = opts.slippayApiBase ?? SLIPPAY_API_BASE;
  const fallbackKey = opts.fallbackKey ?? FALLBACK_KEY;
  const store = opts.paymentsStore ?? payments;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async (req, res) => {
    const host = req.headers?.host ?? `localhost:${opts.port ?? PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;

    // 1. Manifest — declares the payment method VTEX will offer.
    if (req.method === "GET" && path === "/manifest") {
      return json(res, 200, {
        paymentMethods: [{ name: "SlipPay", allowsSplit: "disabled" }],
      });
    }

    // Optional VTEX PPP auth header check on /payments
    if (opts.expectedAppKey || opts.expectedAppToken) {
      if (!verifyVtexAuth(req.headers ?? {}, opts.expectedAppKey, opts.expectedAppToken)) {
        return json(res, 401, { error: "unauthorized", message: "invalid VTEX credentials" });
      }
    }

    // 2. Create Payment — idempotent. Maps to a SlipPay order + checkout_url.
    if (req.method === "POST" && path === "/payments") {
      const b = await readBody(req);
      const paymentId = b.paymentId ?? randomUUID();

      // Idempotency: same paymentId returns the same result.
      if (store.has(paymentId)) {
        const p = store.get(paymentId);
        return json(res, 200, { paymentId, status: p.status, tid: p.slippayOrderId, paymentUrl: p.checkoutUrl });
      }

      const apiKey = b.merchantSettings?.api_key || fallbackKey;
      if (!apiKey) return json(res, 200, { paymentId, status: "denied", message: "missing SlipPay api_key (merchantSettings)" });

      try {
        const { order, checkout_url } = await createSlippayOrder({
          apiKey, value: b.value, reference: paymentId, apiBase, fetchImpl,
        });
        store.set(paymentId, {
          slippayOrderId: order.id, callbackUrl: b.callbackUrl, status: "undefined", checkoutUrl: checkout_url,
        });
        // status "undefined" = pending/async; VTEX redirects the buyer to
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
    //    notify VTEX so it finalizes the transaction.
    if (req.method === "POST" && path === "/slippay-webhook") {
      const b = await readBody(req);
      const orderId = b.order?.id ?? b.order_id ?? b.id;
      const paid = (b.event ?? b.order?.status) === "order.paid" || b.order?.status === "paid";
      const entry = [...store.entries()].find(([, p]) => p.slippayOrderId === orderId);
      if (entry && paid && entry[1].callbackUrl) {
        const [paymentId, p] = entry;
        p.status = "approved";
        await fetchImpl(p.callbackUrl, {
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

    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, slippay: apiBase });

    json(res, 404, { error: "not_found", path });
  };
}

export const server = http.createServer(createRequestHandler());

// Only auto-listen if run directly as main script
const isMain = process.argv[1] && (
  process.argv[1].endsWith("src/index.mjs") ||
  process.argv[1].endsWith("src\\index.mjs")
);

if (isMain && process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    console.log(`SlipPay×VTEX connector on :${PORT} → ${SLIPPAY_API_BASE}`);
  });
}

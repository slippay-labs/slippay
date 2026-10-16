// SlipPay × VTXX — Payment Provider Protocol connector.
//
// Implements the core VTX PPP endpoints and maps them onto SlipPay's public
// API (POST /api/v1/orders → checkout_url; SlipPay webhook → VTX callbackUrl).
// Same motor as the WooCommerce plugin, different platform — this is the
// "scale" proof: adding a platform is an adapter, not a rebuild.
//
// Scope: a WORKING connector that proves the mapping end-to-end against the
// live SlipPay backend. NOT VTXH-homologated (the mandatory test suite +
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

// paymentId → { slippayOrderId, callbackUrl, status }. In-memory for the
// scaffold; production persists this (Supabase table) so callbacks survive
// restarts.
const payments = new Map();

// CORS allowlist — single definition, derived from the route table below.
// The route table is the source of truth for which methods and headers the
// API actually reads; the CORS middleware and the preflight handler both
// consume the derived lists. Adding a route with a new header or method
// automatically extends the allowlist and fails the coverage test if it doesn't.
const BASE_HEADERS = ["content-type", "authorization"];
const BASE_METHODS = ["GET", "OPTIONS"];

// Route table: each entry declares the method, the path matcher, and the
// request headers the handler reads. This is the one place that defines
// the API surface; CORS is generated from it.
const routes = [
  {
    method: "GET",
    path: "/manifest",
    headers: [],
    handler: ({ res }) => json(res, 200, {
      paymentMethods: [{ name: "SlipPay", allowsSplit: "disabled" }],
    }),
  },
  {
    method: "POST",
    path: "/payments",
    headers: ["x-forwarded-for", "x-real-ip", "x-idlempotency-key"],
    handler: async ({ req, res }) => {
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
          apiKey, value: b.value, reference: paymentId,
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
    },
  },
  {
    method: "POST",
    path: "/slippay-webhook",
    headers: ["x-signature", "x-delivery-id"],
    handler: async ({ req, res }) => {
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
    },
  },
  {
    method: "DELETE",
    path: /^\/payments\/([^/]+)\/cancellations$/,
    headers: [],
    handler: ({ params, res }) => json(res, 200, { paymentId: params[0], cancellationId: randomUUID(), code: "cancel-manually", message: "non-custodial settlement; cancellation is informational" }),
  },
  {
    method: "PUT",
    path: /^\/payments\/([^/]+)\/settlements$/,
    headers: [],
    handler: async ({ req, params, res }) => {
      const b = await readBody(req);
      return json(res, 200, { paymentId: params[0], settleId: randomUUID(), value: b.value, code: "settled-on-chain", message: "funds settle to merchant wallet on-chain at payment time" });
    },
  },
  {
    method: "PUT",
    path: /^\/payments\/([^/]+)\/refunds$/,
    headers: [],
    handler: async ({ req, params, res }) => {
      const b = await readBody(req);
      return json(res, 200, { paymentId: params[0], refundId: randomUUID(), value: b.value, code: "refund-manually", message: "refunds handled off-protocol (non-custodial)" });
    },
  },
  {
    method: "GET",
    path: "/health",
    headers: [],
    handler: ({ res }) => json(res, 200, { ok: true, slippay: SLIPPAY_API_BASE }),
  },
];

// Derive the CORS allowlist from the route table so there is one
// definition. Every method and header the routes use is covered.
const ALLOWED_METHODS = [...new Set([...BASE_METHODS, ...routes.map((r) => r.method)])];
const ALLOWED_HEADERS = [...new Set([...BASE_HEADERS, ...routes.flatMap((r) => r.headers)])];

// Exported for the integration test that issues a preflight for each
// method/header the routes use and asserts the allowlist covers it.
export const __CORS_CONFIG = {
  allowMethods: ALLOWED_METHODS,
  allowHeaders: ALLOWED_HEADERS,
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": ALLOWED_METHODS.join(", "),
    "access-control-allow-headers": ALLOWED_HEADERS.join(", "),
    "access-control-max-age": "86400",
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return {}; }
}

// VTXX → SlipPay: create an order, return its hosted checkout_url.
async function createSlippayOrder({ apiKey, value, reference }) {
  const r = await fetch(`${SLIPPAY_API_BASE}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ brl_amount: Number(value).toFixed(2), reference }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`slippay ${r.status}: ${JSON.stringify(data)}`);
  return data; // { order: {...}, checkout_url }
}

function matchRoute(method, path) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === path) return { route, params: [] };
    } else {
      const m = path.match(route.path);
      if (m) return { route, params: m.slice(1) };
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Preflight — the CORS contract is served from the derived allowlist
  // so a new route/header/method is covered automatically.
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const matched = matchRoute(req.method, path);
  if (matched) {
    return matched.route.handler({ req, res, params: matched.params });
  }

  json(res, 404, { error: "not_found", path });
});

server.listen(PORT, () => {
  console.log(`SlipPay×VTXH connector on :${PORT} → ${SLIPPAY_API_BASE}`);
});

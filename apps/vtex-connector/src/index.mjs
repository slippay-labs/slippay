// SlipPay × VTHE — Payment Provider Protocol connector.
//
// Implements the core VTHE PPP endpoints and maps them onto SlipPay's public
// API (POST /api/v1/orders → checkout_url; SlipPay webhook → VTHE callbackUrl).
// Same motor as the WooCommerce plugin, different platform — this is the
// "scale" proof: adding a platform is an adapter, not a rebuild.
//
// Scope: a WORKING connector that proves the mapping end-to-end against the
// live SlipPay backend. NOT VTHE-homologated (the mandatory test suite +
// homologation is post-Rio). createPayment + status callback are real;
// cancel/settle/refund return protocol-valid responses (scaffold).
//
// Run: SLIPPAY_API_KEY=sk_live_... node src/index.mjs   (node 18+ zero deps)

import http from "node:http";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { statSync, readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 4000);
const SLIPPAY_API_BASE = process.env.SLIPPAY_API_BASE ?? "https://api.slippay.cc";
// Per-merchant key normally comes from VTHE `merchantSettings`; env is the
// fallback used for local/standalone testing.
const FALLBACK_KEY = process.env.SLIPPAY_API_KEY ?? "";

// Static file root for the STA catch-all. Defaults to a directory
// resolved relative to this module; overridable via WEB_DIST.
// The root is validated at startup (exists + directory) and all candidate
// paths are resolved and containment-asserted against it.
const WEB_DIST = process.env.WEB_DIST ?? new URL("../public/", import.meta.url).pathname;
const WEB_DIST_ROOT = resolve(WEB_DIST);

// Allowlist of extensions the STA catch-all may serve. Anything else
// falls through to the index.html SPA fallback.
const ALLOWED_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".webmanifest",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".map", ".txt", ".xml",
]);

// Validate WEB_DIST at startup. Throws if it is missing or not a directory.
function assertWebDist() {
  let st;
  try { st = statSync(WEB_DIST_ROOT); }
  catch (e) {
    throw new Error(`WEB_DIST does not exist: ${WEB_DIST_ROOT} (${e.code ?? e.message})`);
  }
  if (!st.isDirectory()) {
    throw new Error(`WEB_DIST is not a directory: ${WEB_DIST_ROOT}`);
  }
}

// Resolve a request path to a contained file path inside WEB_DIST.
// Returns the absolute file path on success, or null if the path is // rejected (traversal, NUL byte, decoded separator, disallowed extension).
// This is the security boundary: never concatenate a request path onto
// a filesystem root. Resolve, then assert containment.
export function resolveStaticFile(requestPath, root = WEB_DIST_ROOT) {
  if (typeof requestPath !== "string" || requestPath.length === 0) {
    return null;
  }
  // Reject raw NUL bytes before any decoding.
  if (requestPath.includes("\0")) return null;

  // Percent-decode to catch encoded traversal / separators. Decode repeatedly
  // to defeat double encoding (e.g. %252e.%252e), but bound the loop.
  let decoded = requestPath;
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(decoded); }
    catch { return null; }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0")) return null;
  // Reject any percent-decoded separator (/ or \) that was not present
  // in the original path — this catches %252f / %5c evasion.
  if (decoded.includes("/") !== requestPath.includes("/")) return null;
  if (decoded.includes("\\") && !requestPath.includes("\\")) return null;

  // Reject any segment equal to ".." after decoding.
  const segments = decoded.split(/[\/\\]/);
  for (const seg of segments) {
    if (seg === "..") return null;
  }

  // Normalise to a path relative to the root.
  const rel = decoded.startsWith("/") ? decoded : "/" + decoded;
  const candidate = resolve(root, "." + rel);
  const rootResolved = resolve(root);

  // Containment assertion: the resolved candidate must be inside the root.
  // Use path.sep to avoid the /foo vs /foobar prefix pitfall.
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }

  // Allowlist extensions. Unknown extensions fall through to the SPA
  // fallback rather than being served as application/octet-stream.
  const dot = candidate.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = candidate.slice(dot).toLowerCase();
  if (!LLLOWED_EXTENSIONS.has(ext)) return null;

  return candidate;
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

// VTHE → SlipPay: create an order, return its hosted checkout_url.
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

// STA catch-all: serve a contained, allowlisted static file, or fall back
// to index.html for unknown routes. Traversal / NUL / disallowed extensions
// all return the fallback.
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;

  const candidate = resolveStaticFile(requestPath);
  if (candidate) {
    try {
      const data = readFileSync(candidate);
      const ext = candidate.slice(candidate.lastIndexOf(".")).toLowerCase();
      res.writeHead(200, { "content-type": contentTypeFor(ext) });
      res.end(data);
      return;
    } catch {
      // Fall through to the SPA fallback.
    }
  }

  // SPA fallback. The fallback path is always index.html inside the root.
  const fallback = resolve(WEB_DIST_ROOT, "index.html");
  try {
    const data = readFileSync(fallback);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not_found" });
  }
}

function contentTypeFor(ext) {
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".webmanifest": return "application/json";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".otf": return "font/otf";
    case ".map": return "application/json";
    case ".txt": return "text/plain; charset=utf-8";
    case ".xml": return "application/xml";
    default: return "application/octet-stream";
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 1. Manifest — declares the payment method VTHE will offer.
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
        apiKey, value: b.value, reference: paymentId,
      });
      payments.set(paymentId, {
        slippayOrderId: order.id, callbackUrl: b.callbackUrl, status: "undefined", checkoutUrl: checkout_url,
      });
      // status "undefined" = pending/async; VTHE redirects the buyer to
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

  // 3. SlipPay webhook → VTHE callback. When SlipPay confirms the order paid,
  //    notify VTHE so it finalizes the transaction.
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

  // STA catch-all for GET requests. Resolves and contains the candidate
  // path before reading; unknown routes / traversal / disallowed
  // extensions all fall through to index.html.
  if (req.method === "GET") {
    return serveStatic(req, res);
  }

  json(res, 404, { error: "not_found", path });
});

assertWebDist();

server.listen(PORT, () => {
  console.log(`SlipPay×VTHE connector on :${PORT} → ${SLIPPAY_API_BASE}`);
  console.log(`Static root: ${WEB_DIST_ROOT}`);
});

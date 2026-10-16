// SlipPay × Shopify — connector.
//
// Three integration modes on one zero-dep server (node 18+):
//
// A) PUBLIC OAUTH APP (multi-shop, distributable by install link):
//    GET  /shopify/install?shop=x.myshopify.com  → Shopify OAuth authorize
//    GET  /shopify/oauth/callback                → token exchange, webhook
//         registration, redirect to per-shop settings page
//    GET/POST /shopify/settings                  → merchant pastes SlipPay creds
//    POST /shopify/gdpr/*                        → mandatory compliance hooks
//    Requires SHOPIFY_APP_KEY + SHOPIFY_APP_SECRET (from the Partner app).
//
// B) LEGACY SINGLE-SHOP custom app (env SHOPIFY_SHOP/ACCESS_TOKEN/WEBHOOK_SECRET)
//    — kept working as the fallback when a webhook's shop has no OAuth record.
//
// Both A and B share the same money path:
//    orders/create (HMAC verified) → SlipPay order (external_ref=shopify:<id>).
//    → buyer pays via /shopify/pay/<order_number> → SlipPay order.paid
//    (signature verified) → mark the Shopify order paid via Admin API.
//
// C) Payments App scaffold (/payment_sessions etc.) — future official gateway.
//
// State persists to STATE_FILE. Run: node src/index.mjs

import http from "node:http";
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 4001);
const SLIPPAY_API_BASE = process.env.SLIPPAY_API_BASE ?? "https://api.slippay.cc";
// Public base of THIS connector as seen by Shopify/browsers.
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://api.slippay.cc/shopify";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-10";
// OAuth app credentials (Partner dashboard → app → Client credentials).
const APP_KEY = process.env.SHOPIFY_APP_KEY ?? "";
const APP_SECRET = process.env.SHOPIFY_APP_SECRET ?? "";
const OAUTH_SCOPES = process.env.SHOPIFY_APP_SCOPES ?? "read_orders,write_orders";
// Default SlipPay merchant credentials (used when a shop has none of its own).
const SLIPPAY_API_KEY = process.env.SLIPPAY_API_KEY ?? "";
const SLIPPAY_WEBHOOK_SECRET = process.env.SLIPPAY_WEBHOOK_SECRET ?? "";
// Legacy single-shop custom app (mode B).
const LEGACY_SHOP = process.env.SHOPIFY_SHOP ?? "";
const LEGACY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const LEGACY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";
const GATEWAY_MATCH = (process.env.SLIPPAY_GATEWAY_MATCH ?? "slippay").toLowerCase();
const STATE_FILE = process.env.STATE_FILE ?? "./shopify-connector-state.json";
const WEBHOOK_TOLERANCE_S = 300;
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// ---------- CORS contract (single source of truth) ----------
// Methods and headers the routes below actually read. Keep in sync with the
// route table; the integration test asserts every declared method/header is
// covered by the preflight response.
export const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const CORS_HEADERS = [
  "authorization",
  "content-type",
  "x-forwarded-for",
  "x-real-ip",
  "x-shopify-hmac-sha256",
  "x-shopify-shop-domain",
  "x-shopify-topic",
  "x-shopify-webhook-id",
  "x-slippay-signature",
  "idempotency-key",
];

// ---------- state ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
const state = { orders: {}, sessions: {}, shops: {}, nonces: {}, ...loadState() };
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// ---------- helpers ----------
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const html = (res, code, body) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};
const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const parse = (buf) => { try { return JSON.parse(buf.toString("utf8")); } catch { return {}; } };
const esc = (s) => String(s ?? "").replace(/[&<>'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
  return timingSafeEqual(ba, bb);
}

// Apply the CORS allowlist derived from CORS_METHODS/CORS_HEADERS. Called for
// every request so preflight (OPTIONS) and actual responses share one source.
function applyCors(req, res) {
  const origin = req.headers["origin"] ?? "*";
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", CORS_METHODS.join(", "));
  res.setHeader("access-control-allow-headers", CORS_HEADERS.join(", "));
  res.setHeader("access-control-max-age", "86400");
}

// Shopify webhook HMAC: base64(HMAC-SHA256(secret, raw body)).
// OAuth-app webhooks are signed with the app secret; legacy custom-app
// webhooks with the custom app's API secret key. Accept either.
export function verifyShopifyWebhookHmac(rawBody, header, secrets = [APP_SECRET, LEGACY_WEBHOOK_SECRET]) {
  if (!header) return false;
  const list = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of list) {
    if (!secret) continue;
    const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
    if (safeEqual(digest, header)) return true;
  }
  return false;
}

// Shopify OAuth/App-URL query HMAC: hex HMAC-SHA256 over the sorted query
// string (minus hmac/signature), keyed with the app secret.
export function verifyShopifyQueryHmac(params, secret = APP_SECRET) {
  if (!secret) return false;
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const msg = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k], v) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(msg).digest("hex");
  return safeEqual(digest, hmac);
}

// SlipPay webhook signature: "t=<sec>,v1=<hex hmac over `${t}.${body}`>".
export function verifySlippaySig(rawBody, header, secrets) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")));
  const t = Number(parts.t);
  if (!isFinite(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > WEBHOOK_TOLERANCE_S) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const hex = createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
    if (safeEqual(`t=${t},v1=${hex}`, header)) return true;
  }
  return false;
}

async function createSlippayOrder({ apiKey, amount, externalRef }) {
  const r = await fetch(`${SLIPPAY_API_BASE}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ brl_amount: Number(amount).toFixed(2), external_ref: externalRef }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`slippay ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// Per-shop credentials: OAuth record → legacy env → none.
function shopCreds(shop) {
  const rec = state.shops[shop];
  if (rec?.accessToken) {
    return {
      token: rec.accessToken,
      slippayApiKey: rec.slippayApiKey || SLIPPAY_API_KEY,
      slippayWebhookSecret: rec.slippayWebhookSecret || SLIPPAY_WEBHOOK_SECRET,
    };
  }
  if (shop === LEGACY_SHOP || !shop) {
    return { token: LEGACY_TOKEN, slippayApiKey: SLIPPAY_API_KEY, slippayWebhookSecret: SLIPPAY_WEBHOOK_SECRET };
  }
  return { token: "", slippayApiKey: SLIPPAY_API_KEY, slippayWebhookSecret: SLIPPAY_WEBHOOK_SECRET };
}

async function shopifyAdmin(shop, token, path, method = "GET", body) {
  if (!shop || !token) return { skipped: "no shop/token" };
  const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method,
    headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function markShopifyOrderPaid(shop, token, orderId, { amount, currency, txHash }) {
  let out = await shopifyAdmin(shop, token, `/orders/${orderId}/transactions.json`, "POST", {
    transaction: { kind: "capture", status: "success" },
  });
  if (out.status >= 400) {
    out = await shopifyAdmin(shop, token, `/orders/${orderId}/transactions.json`, "POST", {
      transaction: { kind: "sale", status: "success", amount, currency, source: "external" },
    });
  }
  if (txHash) {
    await shopifyAdmin(shop, token, `/orders/${orderId}.json`, "PUT", {
      order: { id: orderId, note_attributes: [{ name: "slippay_tx", value: txHash }] },
    });
  }
  return out;
}

async function registerOrdersWebhook(shop, token) {
  const address = `${APP_BASE_URL}/orders-create`;
  const { data } = await shopifyAdmin(shop, token, "/webhooks.json");
  const dup = (data.webhooks ?? []).find(w => w.topic === "orders/create" && w.address === address);
  if (dup) return dup.id;
  const out = await shopifyAdmin(shop, token, "/webhooks.json", "POST", {
    webhook: { topic: "orders/create", address: address, format: "json" },
  });
  return out.data?.webhook?.id ?? null;
}

// ---------- settings page (mode A) ----------
function settingsUrl(shop) {
  const rec = state.shops[shop];
  return `${APP_BASE_URL}/settings?shop=${encodeURIComponent(shop)}&t=${rec?.settingsToken ?? ""}`;
}
function settingsPage(shop, saved = false) {
  const rec = state.shops[shop] ?? {};
  return `<!doctype html><meta charset="utf-8"><title>SlipPay · ${esc(shop)}</title>
<style>body{font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px;color:#111}
input{width:100%;padding:10px;margin:6px 0 16px;border:1px solid #bbb;border-radius:6px;font-family:monospace}
button{background:#111;color:#fff;border:0;padding:12px 24px;border-radius:6px;cursor:pointer}
.ok{background:#e6f6e6;border:1px solid #9c9;padding:10px;border-radius:6px;margin-bottom:16px}
code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style>
<h1>SlipPay</h1>
<p>Loja: <b>${esc(shop)}</b> · app instalado ✓ · webhook de pedidos ✓</p>
${saved ? '<div class="ok">Configuração salva.</div>' : ""}
<form method="post" action="${esc(settingsUrl(shop))}">
  <label>SlipPay API key (do seu dashboard SlipPay)</label>
  <input name="slippay_api_key" placeholder="sk_live_..." value="${esc(rec.slippayApiKey ?? "")}">
  <label>SlipPay webhook secret (do mesmo dashboard)</label>
  <input name="slippay_webhook_secret" placeholder="hex" value="${esc(rec.slippayWebhookSecret ?? "")}">
  <button>Salvar</button>
</form>
<p>Depois de salvar: no dashboard SlipPay, configure webhook URL para
<code>${esc(APP_BASE_URL)}/slippay-webhook</code>. Crie também o método de
pagamento manual <code>SlipPay (USDC)</code> em Settings → Payments da sua loja,
com a instrução: <i>"Para pagar, acesse ${esc(APP_BASE_URL)}/pay/ seguido do
número do seu pedido"</i>.</p>
<p>Sem chave própria, a loja usa a conta SlipPay padrão do conector (se houver).</p>`;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // The connector is reverse-proxied at /shopify/* — accept both forms.
  const path = url.pathname.replace(/^\/shopify(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ---- mode A: OAuth install flow ----
  if (req.method === "GET" && (path === "/install" || path === "/app")) {
    const shop = q.get("shop") ?? "";
    if (!SHOP_RE.test(shop)) return json(res, 400, { error: "invalid shop" });
    if (!APP_KEY) return json(res, 500, { error: "app not configured" });
    const nonce = randomUUID();
    state.nonces[nonce] = { shop, at: Date.now() };
    saveState();
    const authUrl = `https://${shop}/admin/oauth/authorize?shop=${encodeURIComponent(shop)}&client_id=${encodeURIComponent(APP_KEY)}&redirect_uri=${encodeURIComponent(`${APP_BASE_URL}/oauth/callback`)}&response_type=code&nonce=${encodeURIComponent(nonce)}&scope=${encodeURIComponent(OAUTH_SCOPES)}`;
    return redirect(res, authUrl);
  }

  // ---- mode A: OAuth callback ----
  if (req.method === "GET" && path === "/oauth/callback") {
    const shop = q.get("shop") ?? "";
    const code = q.get("code") ?? "";
    const nonce = q.get("nonce") ?? "";
    if (!SHOP_RE.test(shop)) return json(res, 400, { error: "invalid shop" });
    if (!verifyShopifyQueryHmac(q)) return json(res, 401, { error: "hmac verification failed" });
    if (!state.nonces[nonce]) { return json(res, 401, { error: "invalid nonce" }); }
    delete state.nonces[nonce];
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: APP_KEY, client_secret: APP_SECRET, code }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes["ok"] || !tokenData.access_token) {
      if (!tokenData.access_token) return json(res, 402, { error: "token exchange failed", detail: tokenData });
    }
    const settingsToken = randomBytes(16).toString("hex");
    state.shops[shop] = {
      ...(state.shops[shop] ?? {}),
      accessToken: tokenData.access_token,
      scope: tokenData.scope ?? OAUTH_SCOPES,
      settingsToken,
      installedAt: Date.now(),
    };
    saveState();
    await registerOrdersWebhook(shop, tokenData.access_token).catch(() => null);
    return redirect(res, settingsUrl(shop));
  }

  // ---- mode A: settings page -----
  if (path === "/settings") {
    const shop = q.get("shop") ?? "";
    const token = q.get("t") ?? "";
    if (!SHOP_RE.test(shop)) return json(res, 400, { error: "invalid shop" });
    const rec = state.shops[shop];
    if (!rec || rec.settingsToken !== token) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET") return html(res, 200, settingsPage(shop));
    if (req.method === "POST") {
      const raw = await realRawBody(req);
      const form = new URLSearchParams(raw.toString("utf8"));
      rec.slippayApiKey = form.get("slippay_api_key") ?? rec.slippayApiKey;
      rec.slippayWebhookSecret = form.get("slippay_webhook_secret") ?? rec.slippayWebhookSecret;
      saveState();
      return html(res, 200, settingsPage(shop, true));
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ---- mode A: GDPR compliance hooks ----
  if (path.startsWith("/gdpr/")) {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyShopifyWebhookHmac(raw, hmac)) return json(res, 401, { error: "hmac verification failed" });
    const shop = req.headers["x-shopify-shop-domain"] ?? "";
    const topic = req.headers["x-shopify-topic"] ?? "";
    const payload = parse(raw);
    if (path === "/gdpr/customers-data-request") {
      return json(res, 200, { account_id: state.shops[shop]?.accountId ?? null, customer: payload.customer ?? null });
    }
    if (path === "/gdpr/customers-red-act") {
      delete state.orders[payload.order_id];
      saveState();
      return json(res, 200, { ok: true });
    }
    if (path === "/gdpr/shop-red-act") {
      delete state.shops[shop];
      saveState();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "unknown gdpr topic", topic });
  }

  // ---- mode A: orders/create webhook ----
  if (path === "/orders-create") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyShopifyWebhookHmac(raw, hmac)) return json(res, 401, { error: "hmac verification failed" });
    const shop = req.headers["x-shopify-shop-domain"] ?? "";
    const order = parse(raw);
    const creds = shopCreds(shop);
    if (!creds.slippayApiKey) return json(res, 500, { error: "no slippay credentials for shop" });
    const externalRef = `shopify:${order.id}`;
    const created = await createSlippayOrder({
      apiKey: creds.slippayApiKey,
      amount: order.total_price ?? "0",
      externalRef,
    });
    state.orders[order.id] = {
      shop,
      orderNumber: order.name ?? String(order.id),
      slippayOrderId: created.id ?? created.order_id ?? null,
      amount: order.total_price,
      currency: order.currency ?? "USD",
      externalRef,
      paid: false,
      at: Date.now(),
    };
    saveState();
    return json(res, 200, { ok: true, externalRef });
  }

  // ---- mode A: buyer payment page ----
  if (req.method === "GET" && path.startsWith(("/pay/"))) {
    const number = decodeURIComponent(path.slice(5));
    const entry = Object.values(state.orders).find(o => o.orderNumber === number);
    if (!entry) return html(res, 404, "<h1>Pedido não encontrado</h1>");
    const payUrl = `${SLIPPAY_API_BASE}/pay/${entry.slippayOrderId ?? ""}`;
    return html(res, 200, `<!doctype html><meta charset="utf-8"><title>Pagar ${esc(number)}</title>
<style>body{font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px}a.btn{display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none}</style>
<h1>Pedido ${esc(number)}</h1><p>Total: <b>${esc(entry.amount)} ${esc(entry.currency)}</b></p>
<p><a class="btn" href="${esc(payUrl)}">Pagar com SlipPay</a></p>`);
  }

  // ---- mode A/B: SlipPay webhook ----
  if (path === "/slippay-webhook") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = await readRawBody(req);
    const sig = req.headers["x-slippay-signature"];
    const secrets = Object.values(state.shops).map(s => s.slippayWebhookSecret).filter(Boolean);
    secrets.push(SLIPPAY_WEBHOOK_SECRET);
    if (!verifySlippaySig(raw, sig, secrets)) return json(res, 401, { error: "signature verification failed" });
    const event = parse(raw);
    if (event.type !== "order.paid") return json(res, 200, { ok: true, ignored: event.type });
    const externalRef = event.data?.external_ref ?? "";
    const orderId = externalRef.startsWith("shopify:") ? externalRef.slice(8) : null;
    if (!orderId) return json(res, 200, { ok: true, ignored: "no order" });
    const entry = state.orders[orderId];
    if (!entry) return json(res, 200, { ok: true, ignored: "unknown order" });
    const creds = shopCreds(entry.shop);
    await markShopifyOrderPaid(entry.shop, creds.token, orderId, {
      amount: entry.amount,
      currency: entry.currency,
      txHash: event.data?.tx_hash ?? null,
    }).catch(() => null);
    entry.paid = true;
    entry.paidAt = Date.now();
    saveState();
    return json(res, 200, { ok: true });
  }

  // ---- mode B: legacy custom app webhook ----
  if (path === "/legacy/orders-create") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyShopifyWebhookHmac(raw, hmac, [LEGACY_WEBHOOK_SECRET])) return json(res, 401, { error: "hmac verification failed" });
    const order = parse(raw);
    if (!SLIPPAY_API_KEY) return json(res, 500, { error: "no slippay credentials" });
    const externalRef = `shopify:${order.id}`;
    const created = await createSlippayOrder({ apiKey: SLIPPAY_API_KEY, amount: order.total_price ?? "0", externalRef });
    state.orders[order.id] = {
      shop: LEGACY_SHOP,
      orderNumber: order.name ?? String(order.id),
      slippayOrderId: created.id ?? created.order_id ?? null,
      amount: order.total_price,
      currency: order.currency ?? "USD",
      externalRef,
      paid: false,
      at: Date.now(),
    };
    saveState();
    return json(res, 200, { ok: true, externalRef });
  }

  // ---- mode A/B: list orders (debug) ----
  if (req.method === "GET" && path === "/orders") {
    return json(res, 200, { orders: Object.values(state.orders) });
  }

  // ---- mode C: Payments App scaffold ----
  if (path === "/payment_sessions") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = await readRawBody(req);
    const body = parse(raw);
    const id = randomUUID();
    state.sessions[id] = { id, ...body, at: Date.now() };
    saveState();
    return json(res, 201, { id, redirect_url: `${APP_BASE_URL}/pay/${id}` });
  }

  return json(res, 404, { error: "not found", path });
});

server.listen(PORT, () => {
  console.log(`slippay-shopify connector listening on :${PORT}`);
});

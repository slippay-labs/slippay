import type { Context } from "hono";

export const SHOPIFY_CONNECTOR_URL = Deno.env.get("SHOPIFY_CONNECTOR_URL") ?? "http://localhost:4001";
export const SHOPIFY_PROXY_TIMEOUT_MS = 10_000;
export const MAX_SHOPIFY_PROXY_BODY_BYTES = 512 * 1024; // 512 KB

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface RoutePattern {
  method: string;
  pattern: RegExp;
}

const ALLOWED_ROUTES: RoutePattern[] = [
  // Mode A: Public OAuth App
  { method: "GET", pattern: /^\/shopify\/install$/ },
  { method: "GET", pattern: /^\/shopify\/oauth\/callback$/ },
  { method: "GET", pattern: /^\/shopify\/settings$/ },
  { method: "POST", pattern: /^\/shopify\/settings$/ },

  // Mandatory GDPR Compliance Hooks
  { method: "POST", pattern: /^\/shopify\/gdpr\/(shop-redact|customers-data-request|customers-redact)$/ },

  // Core Money & Webhook Path
  { method: "POST", pattern: /^\/shopify\/orders-create$/ },
  { method: "GET", pattern: /^\/shopify\/pay\/[^/]+$/ },
  { method: "POST", pattern: /^\/shopify\/slippay-webhook$/ },

  // Mode C: Payments App Sessions
  { method: "POST", pattern: /^\/shopify\/payment_sessions$/ },
  { method: "POST", pattern: /^\/shopify\/refund_sessions$/ },
  { method: "POST", pattern: /^\/shopify\/capture_sessions$/ },
  { method: "POST", pattern: /^\/shopify\/void_sessions$/ },
];

/**
 * Validates whether the incoming method and pathname match an explicitly allowed connector route.
 */
export function isAllowedShopifyRoute(method: string, pathname: string): boolean {
  const normMethod = method.toUpperCase();
  // Strip trailing slashes for exact route matching
  const normPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ALLOWED_ROUTES.some((r) => r.method === normMethod && r.pattern.test(normPath));
}

/**
 * Strips hop-by-hop headers and updates host header for the proxied target request.
 */
export function buildProxyHeaders(reqHeaders: Headers, targetHost: string): Headers {
  const headers = new Headers();
  for (const [key, value] of reqHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue;
    if (lowerKey === "host") continue;
    headers.set(key, value);
  }
  headers.set("host", targetHost);
  return headers;
}

/**
 * Forwarding handler for /shopify/* routes with strict path validation, hop-by-hop filtering,
 * body size capping, and timeout protection (Issue #187).
 */
export async function proxyShopifyRequest(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const method = c.req.method.toUpperCase();

  if (!isAllowedShopifyRoute(method, url.pathname)) {
    return c.json(
      {
        error: "not_found",
        message: `Route ${method} ${url.pathname} is not an authorized Shopify connector endpoint.`,
      },
      404,
    );
  }

  // Enforce body size limits on payload-carrying requests
  let body: ArrayBuffer | undefined = undefined;
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = c.req.header("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SHOPIFY_PROXY_BODY_BYTES) {
      return c.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum size of ${MAX_SHOPIFY_PROXY_BODY_BYTES} bytes.`,
        },
        413,
      );
    }

    body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_SHOPIFY_PROXY_BODY_BYTES) {
      return c.json(
        {
          error: "payload_too_large",
          message: `Request body exceeds maximum size of ${MAX_SHOPIFY_PROXY_BODY_BYTES} bytes.`,
        },
        413,
      );
    }
  }

  const connectorBase = Deno.env.get("SHOPIFY_CONNECTOR_URL") ?? SHOPIFY_CONNECTOR_URL;
  const targetBaseUrl = new URL(connectorBase);
  const target = `${connectorBase}${url.pathname}${url.search}`;
  const proxyHeaders = buildProxyHeaders(c.req.raw.headers, targetBaseUrl.host);

  try {
    const r = await fetch(target, {
      method,
      headers: proxyHeaders,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(SHOPIFY_PROXY_TIMEOUT_MS),
    });

    const responseHeaders = new Headers();
    for (const [k, v] of r.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
        responseHeaders.set(k, v);
      }
    }

    return new Response(r.body, { status: r.status, headers: responseHeaders });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "TimeoutError") {
      return c.json({ error: "gateway_timeout", message: "Shopify connector response timed out." }, 504);
    }
    return c.json({ error: "bad_gateway", message: `Shopify connector unreachable: ${msg}` }, 502);
  }
}

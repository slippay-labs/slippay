import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import {
  isAllowedShopifyRoute,
  buildProxyHeaders,
  proxyShopifyRequest,
  MAX_SHOPIFY_PROXY_BODY_BYTES,
} from "../lib/shopify_proxy.ts";

Deno.test("isAllowedShopifyRoute allows only specified connector endpoints and methods", () => {
  // Allowed routes
  assert(isAllowedShopifyRoute("GET", "/shopify/install"));
  assert(isAllowedShopifyRoute("GET", "/shopify/oauth/callback"));
  assert(isAllowedShopifyRoute("GET", "/shopify/settings"));
  assert(isAllowedShopifyRoute("POST", "/shopify/settings"));
  assert(isAllowedShopifyRoute("POST", "/shopify/gdpr/shop-redact"));
  assert(isAllowedShopifyRoute("POST", "/shopify/gdpr/customers-data-request"));
  assert(isAllowedShopifyRoute("POST", "/shopify/gdpr/customers-redact"));
  assert(isAllowedShopifyRoute("POST", "/shopify/orders-create"));
  assert(isAllowedShopifyRoute("GET", "/shopify/pay/1001"));
  assert(isAllowedShopifyRoute("GET", "/shopify/pay/order-xyz-123"));
  assert(isAllowedShopifyRoute("POST", "/shopify/slippay-webhook"));
  assert(isAllowedShopifyRoute("POST", "/shopify/payment_sessions"));
  assert(isAllowedShopifyRoute("POST", "/shopify/refund_sessions"));
  assert(isAllowedShopifyRoute("POST", "/shopify/capture_sessions"));
  assert(isAllowedShopifyRoute("POST", "/shopify/void_sessions"));

  // Disallowed paths and methods
  assertEquals(isAllowedShopifyRoute("GET", "/shopify/debug"), false);
  assertEquals(isAllowedShopifyRoute("POST", "/shopify/debug"), false);
  assertEquals(isAllowedShopifyRoute("GET", "/shopify/health"), false);
  assertEquals(isAllowedShopifyRoute("GET", "/shopify/admin"), false);
  assertEquals(isAllowedShopifyRoute("DELETE", "/shopify/orders-create"), false);
  assertEquals(isAllowedShopifyRoute("PUT", "/shopify/settings"), false);
  assertEquals(isAllowedShopifyRoute("POST", "/shopify/install"), false);
  assertEquals(isAllowedShopifyRoute("GET", "/shopify"), false);
  assertEquals(isAllowedShopifyRoute("GET", "/shopify/"), false);
  assertEquals(isAllowedShopifyRoute("GET", "/shopify/pay/"), false);
});

Deno.test("buildProxyHeaders strips hop-by-hop headers and replaces host", () => {
  const incoming = new Headers({
    "host": "public.api.example.com",
    "connection": "keep-alive",
    "keep-alive": "timeout=5",
    "te": "trailers",
    "upgrade": "websocket",
    "x-shopify-hmac-sha256": "abcdef123456",
    "content-type": "application/json",
  });

  const proxied = buildProxyHeaders(incoming, "localhost:4001");

  assertEquals(proxied.get("host"), "localhost:4001");
  assertEquals(proxied.get("x-shopify-hmac-sha256"), "abcdef123456");
  assertEquals(proxied.get("content-type"), "application/json");

  assertEquals(proxied.has("connection"), false);
  assertEquals(proxied.has("keep-alive"), false);
  assertEquals(proxied.has("te"), false);
  assertEquals(proxied.has("upgrade"), false);
});

Deno.test("proxyShopifyRequest rejects unlisted route with 404 without forwarding", async () => {
  const app = new Hono();
  app.all("/shopify/*", proxyShopifyRequest);

  const res = await app.request("/shopify/debug", { method: "GET" });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "not_found");
  assert(body.message.includes("not an authorized"));
});

Deno.test("proxyShopifyRequest rejects payload exceeding body limit with 413", async () => {
  const app = new Hono();
  app.all("/shopify/*", proxyShopifyRequest);

  // Payload larger than 512 KB
  const oversized = "x".repeat(MAX_SHOPIFY_PROXY_BODY_BYTES + 1024);
  const res = await app.request("/shopify/orders-create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversized,
  });

  assertEquals(res.status, 413);
  const body = await res.json();
  assertEquals(body.error, "payload_too_large");
});

Deno.test("proxyShopifyRequest handles upstream timeout with 504 Gateway Timeout", async () => {
  // Point connector URL to a non-responsive mock server that delays beyond timeout
  const mockServer = Deno.serve({ port: 4099 }, async () => {
    // Delay longer than client timeout
    await new Promise((r) => setTimeout(r, 15_000));
    return new Response("ok");
  });

  Deno.env.set("SHOPIFY_CONNECTOR_URL", "http://localhost:4099");

  const app = new Hono();
  app.all("/shopify/*", proxyShopifyRequest);

  try {
    // Override fetch to abort immediately via AbortSignal to test timeout path fast
    const origFetch = globalThis.fetch;
    globalThis.fetch = () => {
      const err = new Error("The signal has been aborted");
      err.name = "TimeoutError";
      return Promise.reject(err);
    };

    const res = await app.request("/shopify/install", { method: "GET" });
    assertEquals(res.status, 504);
    const body = await res.json();
    assertEquals(body.error, "gateway_timeout");

    globalThis.fetch = origFetch;
  } finally {
    await mockServer.shutdown();
    Deno.env.delete("SHOPIFY_CONNECTOR_URL");
  }
});

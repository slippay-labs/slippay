import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signCheckoutToken, verifyCheckoutToken } from "../lib/checkout-token.ts";
import { b64url, b64urlDecode } from "@slippay/shared";

Deno.env.set("CHECKOUT_TOKEN_SECRET", "supersecretkeyformanagingcheckouttokens12345");

Deno.test("signCheckoutToken generates valid base64url HMAC token", async () => {
  const orderId = "order_bounty_89_test_id";
  const token = await signCheckoutToken(orderId);

  // Assert URL-safe characters and no padding
  assertEquals(/^[A-Za-z0-9_-]+$/.test(token), true);
  assertEquals(token.includes("+"), false);
  assertEquals(token.includes("/"), false);
  assertEquals(token.includes("="), false);

  // Assert decoded length is 32 bytes (SHA-256 HMAC)
  const decoded = b64urlDecode(token);
  assertEquals(decoded.length, 32);

  // Assert byte-identical round-trip
  assertEquals(b64url(decoded), token);
});

Deno.test("verifyCheckoutToken accepts valid and rejects tampered token or order", async () => {
  const orderId = "order_12345_67890";
  const token = await signCheckoutToken(orderId);

  // Correct order & token
  assertEquals(await verifyCheckoutToken(orderId, token), true);

  // Wrong orderId
  assertEquals(await verifyCheckoutToken("different_order_id", token), false);

  // Tampered token
  const tamperedToken = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  assertEquals(await verifyCheckoutToken(orderId, tamperedToken), false);

  // Malformed or empty tokens
  assertEquals(await verifyCheckoutToken(orderId, ""), false);
  assertEquals(await verifyCheckoutToken(orderId, "short"), false);
});

Deno.test("GET /v1/orders/:id/exchange exchanges token for HttpOnly cookie and redirects (303)", async () => {
  const { default: orders } = await import("../routes/orders.ts");
  const { Hono } = await import("hono");
  const app = new Hono().route("/v1/orders", orders);

  const orderId = "order_test_exchange_1";
  const token = await signCheckoutToken(orderId);

  // Valid token exchange
  const res = await app.request(`/v1/orders/${orderId}/exchange?t=${token}`);
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), `http://localhost:5173/checkout/${orderId}`);
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");

  const setCookie = res.headers.get("set-cookie") ?? "";
  assertEquals(setCookie.includes(`checkout_token_${orderId}=${token}`), true);
  assertEquals(setCookie.includes("HttpOnly"), true);
  assertEquals(setCookie.includes("Secure"), true);
  assertEquals(setCookie.includes("SameSite=Lax"), true);

  // Invalid token exchange -> 401
  const badRes = await app.request(`/v1/orders/${orderId}/exchange?t=invalid_token`);
  assertEquals(badRes.status, 401);
});

Deno.test("GET /v1/orders/:id rejects naked URL without cookie or token (captured URL immunity)", async () => {
  const { default: orders } = await import("../routes/orders.ts");
  const { Hono } = await import("hono");
  const app = new Hono().route("/v1/orders", orders);

  const orderId = "order_test_naked_2";

  // Completely naked URL -> 401 unauthorized
  const res = await app.request(`/v1/orders/${orderId}`);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "unauthorized");
});

Deno.test("GET /v1/orders/:id rejects invalid or tampered cookie", async () => {
  const { default: orders } = await import("../routes/orders.ts");
  const { Hono } = await import("hono");
  const app = new Hono().route("/v1/orders", orders);

  const orderId = "order_test_tampered_cookie_3";

  // Request with invalid cookie
  const res = await app.request(`/v1/orders/${orderId}`, {
    headers: {
      cookie: `checkout_token_${orderId}=tampered_token_value_xyz`,
    },
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "unauthorized");
});


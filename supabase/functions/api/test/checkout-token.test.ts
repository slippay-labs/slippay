import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signCheckoutToken, verifyCheckoutToken } from "../lib/checkout-token.ts";
import { b64url, b64urlDecode } from "@slippay/shared";

Deno.env.set("CHECKOUT_TOKEN_SECRET", "supersecretkeyformanagingcheckouttokens12345");

Deno.test("signCheckoutToken generates valid expiring purpose-bound token", async () => {
  const orderId = "order_bounty_89_test_id";
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const token = await signCheckoutToken(orderId, exp);

  // Assert format v1.purpose.exp.sig
  const parts = token.split(".");
  assertEquals(parts.length, 4);
  assertEquals(parts[0], "v1");
  assertEquals(parts[1], "checkout_read");
  assertEquals(parts[2], String(exp));

  const decoded = b64urlDecode(parts[3]!);
  assertEquals(decoded.length, 32);
});

Deno.test("verifyCheckoutToken accepts valid and rejects tampered, wrong order, or expired token", async () => {
  const orderId = "order_12345_67890";
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 1800;
  const token = await signCheckoutToken(orderId, exp);

  // Correct order & token
  assertEquals(await verifyCheckoutToken(orderId, token), true);

  // Wrong orderId
  assertEquals(await verifyCheckoutToken("different_order_id", token), false);

  // Tampered signature
  const parts = token.split(".");
  const sig = parts[3]!;
  parts[3] = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
  assertEquals(await verifyCheckoutToken(orderId, parts.join(".")), false);

  // Tampered purpose
  parts[1] = "order_write";
  parts[3] = sig;
  assertEquals(await verifyCheckoutToken(orderId, parts.join(".")), false);

  // Malformed or empty tokens
  assertEquals(await verifyCheckoutToken(orderId, ""), false);
  assertEquals(await verifyCheckoutToken(orderId, "short"), false);

  // Expired token
  const expiredToken = await signCheckoutToken(orderId, now - 10);
  assertEquals(await verifyCheckoutToken(orderId, expiredToken), false);
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


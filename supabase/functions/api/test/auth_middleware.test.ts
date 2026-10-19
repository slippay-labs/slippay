import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import { requireApiKey } from "../middleware/auth_apikey.ts";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";

Deno.test("requireApiKey rejects missing or invalid authorization header with 401", async () => {
  const app = new Hono();
  app.get("/test", requireApiKey, (c) => c.text("ok"));

  // 1. Missing header
  const res1 = await app.request("/test");
  assertEquals(res1.status, 401);
  const body1 = await res1.json();
  assertEquals(body1.error, "unauthenticated");

  // 2. Unrecognised prefix
  const res2 = await app.request("/test", {
    headers: { authorization: "Bearer sk_unknown_1234567890" },
  });
  assertEquals(res2.status, 401);
  const body2 = await res2.json();
  assertEquals(body2.error, "unauthenticated");

  // 3. Not bearer
  const res3 = await app.request("/test", {
    headers: { authorization: "Basic sk_live_1234567890" },
  });
  assertEquals(res3.status, 401);
});

Deno.test("requireApiKeyOrJwt falls back to session auth when prefix is unrecognized without 500", async () => {
  const app = new Hono();
  app.get("/test", requireApiKeyOrJwt, (c) => c.text("ok"));

  // 1. Unknown prefix -> falls through to JWT validation which fails cleanly with 401
  const res = await app.request("/test", {
    headers: { authorization: "Bearer sk_fake_prefix_12345" },
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "unauthenticated");
});

import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import ordersRoute from "../routes/orders.ts";
import {
  getBrlPerUsdc,
  getBrlPerUsdcWithSource,
  RateOutOfRangeError,
  _resetCacheForTest,
} from "../lib/rate.ts";

Deno.test("getBrlPerUsdcWithSource applies valid override in non-production", async () => {
  _resetCacheForTest();
  Deno.env.delete("ENVIRONMENT");
  Deno.env.delete("DENO_ENV");
  Deno.env.delete("NODE_ENV");
  Deno.env.delete("ALLOW_RATE_OVERRIDE");
  Deno.env.set("RATE_BRL_USDC", "5.85");

  const res = await getBrlPerUsdcWithSource();
  assertEquals(res.rate, 5.85);
  assertEquals(res.source, "override");

  const simpleRate = await getBrlPerUsdc();
  assertEquals(simpleRate, 5.85);
});

Deno.test("getBrlPerUsdcWithSource rejects out-of-band overrides", async () => {
  _resetCacheForTest();
  Deno.env.delete("ENVIRONMENT");
  Deno.env.delete("DENO_ENV");

  // Lower bound breach (< 0.5)
  Deno.env.set("RATE_BRL_USDC", "0.49");
  await assertRejects(
    async () => await getBrlPerUsdcWithSource(),
    RateOutOfRangeError,
    "outside allowed sane band",
  );

  // Upper bound breach (> 20.0)
  Deno.env.set("RATE_BRL_USDC", "20.01");
  await assertRejects(
    async () => await getBrlPerUsdcWithSource(),
    RateOutOfRangeError,
    "outside allowed sane band",
  );

  // Wild malicious rate (e.g. 1e9)
  Deno.env.set("RATE_BRL_USDC", "1000000000");
  await assertRejects(
    async () => await getBrlPerUsdcWithSource(),
    RateOutOfRangeError,
    "outside allowed sane band",
  );

  // Non-numeric
  Deno.env.set("RATE_BRL_USDC", "invalid");
  await assertRejects(
    async () => await getBrlPerUsdcWithSource(),
    RateOutOfRangeError,
    "outside allowed sane band",
  );
});

Deno.test("getBrlPerUsdcWithSource ignores override in production environment", async () => {
  _resetCacheForTest();
  Deno.env.set("DENO_ENV", "production");
  Deno.env.set("RATE_BRL_USDC", "5.85");

  // In production, override is strictly ignored and it falls back to live/cache
  const res = await getBrlPerUsdcWithSource();
  assert(res.source === "live" || res.source === "cache");
  assert(res.rate > 0);

  Deno.env.delete("DENO_ENV");
});

Deno.test("getBrlPerUsdcWithSource respects explicit ALLOW_RATE_OVERRIDE=false", async () => {
  _resetCacheForTest();
  Deno.env.delete("DENO_ENV");
  Deno.env.set("ALLOW_RATE_OVERRIDE", "false");
  Deno.env.set("RATE_BRL_USDC", "5.85");

  const res = await getBrlPerUsdcWithSource();
  assert(res.source === "live" || res.source === "cache");
  assert(res.rate > 0);

  Deno.env.delete("ALLOW_RATE_OVERRIDE");
});

Deno.test("getBrlPerUsdc caches live response within ttl", { sanitizeOps: false, sanitizeResources: false }, async () => {
  _resetCacheForTest();
  Deno.env.delete("RATE_BRL_USDC");
  Deno.env.delete("DENO_ENV");

  const a = await getBrlPerUsdcWithSource();
  const b = await getBrlPerUsdcWithSource();
  assertEquals(a.rate, b.rate);
  assertEquals(b.source, "cache");
});

Deno.test("POST /v1/orders returns 502 rate_out_of_range when BRL rate override is invalid", async () => {
  Deno.env.set("RATE_BRL_USDC", "999.00"); // Out of bounds > 20
  Deno.env.delete("DENO_ENV");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("merchant", { id: "m_test" });
    c.set("supabase", {} as any);
    await next();
  });
  app.route("/v1/orders", ordersRoute);

  const res = await app.request("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brl_amount: "100.00" }),
  });

  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, "rate_out_of_range");
  assert(body.message.includes("outside allowed sane band"));

  Deno.env.delete("RATE_BRL_USDC");
});


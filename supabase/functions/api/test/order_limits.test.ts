import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import ordersRoute from "../routes/orders.ts";
import { checkOrderLimits } from "../lib/order_limits.ts";

Deno.test("checkOrderLimits validates limits correctly for USD, BRL, and converted USDC", () => {
  // 1. Within default limits
  assertEquals(checkOrderLimits(null, { usd_amount: "100.00" }), { allowed: true });
  assertEquals(checkOrderLimits(null, { brl_amount: "500.00" }), { allowed: true });
  assertEquals(checkOrderLimits(null, { usdc_amount: "49999.0000000" }), { allowed: true });

  // 2. Exceeding default limits
  const usdExceeded = checkOrderLimits(null, { usd_amount: "50000.01" });
  assertEquals(usdExceeded.allowed, false);
  assertEquals(usdExceeded.currency, "USD");

  const brlExceeded = checkOrderLimits(null, { brl_amount: "300000.01" });
  assertEquals(brlExceeded.allowed, false);
  assertEquals(brlExceeded.currency, "BRL");

  const usdcExceeded = checkOrderLimits(null, { usdc_amount: "50000.0000001" });
  assertEquals(usdcExceeded.allowed, false);
  assertEquals(usdcExceeded.currency, "USDC");

  // 3. Custom merchant limits
  const customMerchant = { max_order_usdc: 500, max_order_brl: 2500 };
  const customOk = checkOrderLimits(customMerchant, { usd_amount: "450.00" });
  assertEquals(customOk.allowed, true);

  const customExceeded = checkOrderLimits(customMerchant, { usd_amount: "501.00" });
  assertEquals(customExceeded.allowed, false);
  assertEquals(customExceeded.max_allowed, "500.0000000");
});

function createMockOrdersApp(merchantOverride: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("merchant", {
      id: "merchant_test_123",
      stellar_address: "G" + "A".repeat(55),
      platform_fee_bp: 297,
      ...merchantOverride,
    });
    c.set("supabase", {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: {
                id: "ord_mock_1",
                status: "pending",
                usdc_amount: "10.0000000",
                memo: "ab".repeat(32),
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    await next();
  });
  app.route("/v1/orders", ordersRoute);
  return app;
}

Deno.test("POST /v1/orders rejects order exceeding default merchant USD limit with 422", async () => {
  Deno.env.set("RATE_BRL_USDC", "5.00");
  const app = createMockOrdersApp();

  const res = await app.request("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usd_amount: "60000.00" }), // Exceeds default 50k USDC
  });

  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, "order_limit_exceeded");
  assertEquals(body.currency, "USD");
  assert(body.message.includes("exceeds merchant limit"));
});

Deno.test("POST /v1/orders rejects order exceeding default merchant BRL limit with 422", async () => {
  Deno.env.set("RATE_BRL_USDC", "5.00");
  const app = createMockOrdersApp();

  const res = await app.request("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brl_amount: "350000.00" }), // Exceeds default 300k BRL
  });

  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, "order_limit_exceeded");
  assertEquals(body.currency, "BRL");
  assertEquals(body.max_allowed, "300000.00");
});

Deno.test("POST /v1/orders respects merchant custom order limits", async () => {
  Deno.env.set("RATE_BRL_USDC", "5.00");
  const app = createMockOrdersApp({ max_order_usdc: 1000 }); // Custom low limit

  const res = await app.request("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usd_amount: "1500.00" }),
  });

  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, "order_limit_exceeded");
  assertEquals(body.max_allowed, "1000.0000000");
  assert(body.message.includes("1000"));
});

Deno.test("POST /v1/orders allows valid order within limits", async () => {
  Deno.env.set("RATE_BRL_USDC", "5.00");
  Deno.env.set("CHECKOUT_TOKEN_SECRET", "01234567890123456789012345678901");
  const app = createMockOrdersApp();

  const res = await app.request("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usd_amount: "100.00" }),
  });

  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.order.id, "ord_mock_1");
});

// SPDX-License-Identifier: MIT
//
// Tests for billing window parsing, range validation, and route enforcement (Issue #512).

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import billingRouter, {
  validateBillingWindow,
  MAX_BILLING_WINDOW_DAYS,
  getFeesHandler,
  type BillingVars,
} from "../routes/billing.ts";

Deno.test("validateBillingWindow: accepts valid ISO date range", () => {
  const res = validateBillingWindow("2026-05-01T00:00:00.000Z", "2026-05-31T23:59:59.999Z");
  assertEquals(res.ok, true);
  assertEquals(res.from, "2026-05-01T00:00:00.000Z");
  assertEquals(res.to, "2026-05-31T23:59:59.999Z");
});

Deno.test("validateBillingWindow: defaults to calendar month start and now when omitted", () => {
  const fixedNow = new Date("2026-10-19T11:00:00.000Z");
  const res = validateBillingWindow(null, null, fixedNow);
  assertEquals(res.ok, true);
  assertEquals(res.from, "2026-10-01T00:00:00.000Z");
  assertEquals(res.to, "2026-10-19T11:00:00.000Z");
});

Deno.test("validateBillingWindow: rejects malformed 'from' date string", () => {
  const res1 = validateBillingWindow("yesterday", "2026-10-19T11:00:00.000Z");
  assertEquals(res1.ok, false);
  assertEquals(res1.error, "malformed_from_date");
  assertEquals(res1.status, 400);

  const res2 = validateBillingWindow("not-a-date", "2026-10-19T11:00:00.000Z");
  assertEquals(res2.ok, false);
  assertEquals(res2.error, "malformed_from_date");

  // Invalid calendar date with overflow (Feb 31st)
  const res3 = validateBillingWindow("2026-02-31", "2026-03-15");
  assertEquals(res3.ok, false);
  assertEquals(res3.error, "malformed_from_date");
});

Deno.test("validateBillingWindow: rejects malformed 'to' date string", () => {
  const res1 = validateBillingWindow("2026-01-01T00:00:00.000Z", "tomorrow");
  assertEquals(res1.ok, false);
  assertEquals(res1.error, "malformed_to_date");
  assertEquals(res1.status, 400);

  const res2 = validateBillingWindow("2026-01-01T00:00:00.000Z", "2026-13-45");
  assertEquals(res2.ok, false);
  assertEquals(res2.error, "malformed_to_date");
});

Deno.test("validateBillingWindow: rejects reversed window (from > to)", () => {
  const res = validateBillingWindow("2026-05-15T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
  assertEquals(res.ok, false);
  assertEquals(res.error, "reversed_billing_window");
  assertEquals(res.status, 400);
});

Deno.test("validateBillingWindow: rejects empty window (from == to)", () => {
  const same = "2026-05-01T12:00:00.000Z";
  const res = validateBillingWindow(same, same);
  assertEquals(res.ok, false);
  assertEquals(res.error, "reversed_billing_window");
  assertEquals(res.status, 400);
});

Deno.test("validateBillingWindow: rejects window exceeding maximum duration (366 days)", () => {
  const res = validateBillingWindow("2025-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"); // 396 days
  assertEquals(res.ok, false);
  assertEquals(res.error, "billing_window_too_long");
  assertEquals(res.status, 400);
  assert(MAX_BILLING_WINDOW_DAYS === 366);
});

Deno.test("billingRouter without authorization header returns 401 unauthenticated", async () => {
  const app = new Hono();
  app.route("/", billingRouter);
  const res = await app.fetch(new Request("http://localhost/fees"));
  assertEquals(res.status, 401);
  const json = await res.json();
  assertEquals(json.error, "unauthenticated");
});

Deno.test("GET /fees route: rejects malformed 'from' with 400 before querying database", async () => {
  const app = new Hono<{ Variables: BillingVars }>();
  app.use("*", async (c, next) => {
    c.set("merchant", { id: "m_test_1", platform_fee_bp: 98 });
    c.set("supabase", {} as unknown as any);
    await next();
  });
  app.get("/fees", getFeesHandler);

  const res = await app.fetch(new Request("http://localhost/fees?from=yesterday"));
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error, "malformed_from_date");
});

Deno.test("GET /fees route: rejects reversed window with 400", async () => {
  const app = new Hono<{ Variables: BillingVars }>();
  app.use("*", async (c, next) => {
    c.set("merchant", { id: "m_test_1", platform_fee_bp: 98 });
    c.set("supabase", {} as unknown as any);
    await next();
  });
  app.get("/fees", getFeesHandler);

  const res = await app.fetch(new Request("http://localhost/fees?from=2026-10-20&to=2026-10-10"));
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error, "reversed_billing_window");
});

Deno.test("GET /fees route: rejects window exceeding 366 days with 400", async () => {
  const app = new Hono<{ Variables: BillingVars }>();
  app.use("*", async (c, next) => {
    c.set("merchant", { id: "m_test_1", platform_fee_bp: 98 });
    c.set("supabase", {} as unknown as any);
    await next();
  });
  app.get("/fees", getFeesHandler);

  const res = await app.fetch(new Request("http://localhost/fees?from=2025-01-01&to=2026-03-01"));
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error, "billing_window_too_long");
});

Deno.test("GET /fees route: queries database with normalized period on valid input", async () => {
  let capturedGte = "";
  let capturedLte = "";

  const mockSb = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_k1: string, _v1: string) => ({
          eq: (_k2: string, _v2: string) => ({
            gte: (_k3: string, val: string) => {
              capturedGte = val;
              return {
                lte: (_k4: string, toVal: string) => {
                  capturedLte = toVal;
                  return Promise.resolve({
                    data: [
                      { usdc_amount: "100.0000000", fee_usdc: "0.9800000", platform_fee_bp: 98 }
                    ],
                    error: null,
                  });
                }
              };
            }
          })
        })
      })
    })
  };

  const app = new Hono<{ Variables: BillingVars }>();
  app.use("*", async (c, next) => {
    c.set("merchant", { id: "m_test_1", platform_fee_bp: 98 });
    c.set("supabase", mockSb as unknown as any);
    await next();
  });
  app.get("/fees", getFeesHandler);

  const res = await app.fetch(new Request("http://localhost/fees?from=2026-05-01T00:00:00Z&to=2026-05-15T00:00:00Z"));
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.period.from, "2026-05-01T00:00:00.000Z");
  assertEquals(json.period.to, "2026-05-15T00:00:00.000Z");
  assertEquals(capturedGte, "2026-05-01T00:00:00.000Z");
  assertEquals(capturedLte, "2026-05-15T00:00:00.000Z");
  assertEquals(json.orders_count, 1);
  assertEquals(json.gross_usdc, "100.0000000");
  assertEquals(json.fee_usdc_total, "0.9800000");
  assertEquals(json.net_usdc_total, "99.0200000");
});

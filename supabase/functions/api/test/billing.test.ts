import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import billing, {
  validateBillingWindow,
  MAX_BILLING_WINDOW_DAYS,
} from "../routes/billing.ts";

Deno.test("validateBillingWindow: rejects invalid from date", () => {
  const res = validateBillingWindow("yesterday", "2026-10-21T00:00:00Z");
  assertEquals(res.valid, false);
  if (!res.valid) {
    assertEquals(res.error, "invalid_from_date");
  }
});

Deno.test("validateBillingWindow: rejects invalid to date", () => {
  const res = validateBillingWindow("2026-10-01T00:00:00Z", "not-a-date");
  assertEquals(res.valid, false);
  if (!res.valid) {
    assertEquals(res.error, "invalid_to_date");
  }
});

Deno.test("validateBillingWindow: rejects reversed window (from > to)", () => {
  const res = validateBillingWindow("2026-10-20T00:00:00Z", "2026-10-10T00:00:00Z");
  assertEquals(res.valid, false);
  if (!res.valid) {
    assertEquals(res.error, "invalid_window");
  }
});

Deno.test("validateBillingWindow: rejects zero-duration window (from == to)", () => {
  const res = validateBillingWindow("2026-10-10T12:00:00Z", "2026-10-10T12:00:00Z");
  assertEquals(res.valid, false);
  if (!res.valid) {
    assertEquals(res.error, "invalid_window");
  }
});

Deno.test("validateBillingWindow: rejects window exceeding 366 days", () => {
  const res = validateBillingWindow("2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  assertEquals(res.valid, false);
  if (!res.valid) {
    assertEquals(res.error, "window_too_large");
  }
});

Deno.test("validateBillingWindow: accepts valid window within bounds", () => {
  const res = validateBillingWindow("2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  assertEquals(res.valid, true);
  if (res.valid) {
    assertEquals(res.from, "2026-09-01T00:00:00.000Z");
    assertEquals(res.to, "2026-09-30T23:59:59.000Z");
  }
});

Deno.test("validateBillingWindow: defaults from to 1st of current month and to to now", () => {
  const mockNow = new Date("2026-10-21T12:30:00.000Z");
  const res = validateBillingWindow(undefined, undefined, mockNow);
  assertEquals(res.valid, true);
  if (res.valid) {
    assertEquals(res.from, "2026-10-01T00:00:00.000Z");
    assertEquals(res.to, "2026-10-21T12:30:00.000Z");
  }
});

Deno.test("validateBillingWindow: supports exactly 366 days", () => {
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date(from.getTime() + MAX_BILLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const res = validateBillingWindow(from.toISOString(), to.toISOString());
  assertEquals(res.valid, true);
});

Deno.test("GET /fees without auth returns 401 unauthenticated", async () => {
  const testApp = new Hono();
  testApp.route("/v1/billing", billing);
  const res = await testApp.request("/v1/billing/fees");
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "unauthenticated");
});

Deno.test("GET /fees with malformed auth returns 401 unauthenticated", async () => {
  const testApp = new Hono();
  testApp.route("/v1/billing", billing);
  const res = await testApp.request("/v1/billing/fees", {
    headers: { authorization: "Basic 12345" },
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "unauthenticated");
});

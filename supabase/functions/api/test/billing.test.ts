import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import billingApp, {
  validateBillingWindow,
  MAX_BILLING_WINDOW_DAYS,
} from "../routes/billing.ts";

Deno.test("validateBillingWindow: accepts valid ISO dates and returns normalised ISO strings", () => {
  const fromStr = "2026-01-01T00:00:00.000Z";
  const toStr = "2026-01-31T23:59:59.999Z";
  const res = validateBillingWindow(fromStr, toStr);

  assertEquals(res.ok, true);
  if (res.ok) {
    assertEquals(res.fromIso, fromStr);
    assertEquals(res.toIso, toStr);
    assert(res.from instanceof Date);
    assert(res.to instanceof Date);
  }
});

Deno.test("validateBillingWindow: uses default calendar month when from and to are omitted", () => {
  const fixedNow = new Date("2026-06-15T12:00:00.000Z");
  const res = validateBillingWindow(undefined, undefined, fixedNow);

  assertEquals(res.ok, true);
  if (res.ok) {
    assertEquals(res.toIso, fixedNow.toISOString());
    const expectedFrom = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), 1).toISOString();
    assertEquals(res.fromIso, expectedFrom);
  }
});

Deno.test("validateBillingWindow: rejects malformed from date with 400", () => {
  const res1 = validateBillingWindow("yesterday", "2026-06-15T00:00:00.000Z");
  assertEquals(res1.ok, false);
  if (!res1.ok) {
    assertEquals(res1.status, 400);
    assertEquals(res1.error, "invalid_from_date");
  }

  const res2 = validateBillingWindow("2026-13-45", "2026-06-15T00:00:00.000Z");
  assertEquals(res2.ok, false);
  if (!res2.ok) {
    assertEquals(res2.status, 400);
    assertEquals(res2.error, "invalid_from_date");
  }

  const res3 = validateBillingWindow("   ", "2026-06-15T00:00:00.000Z");
  assertEquals(res3.ok, false);
  if (!res3.ok) {
    assertEquals(res3.status, 400);
    assertEquals(res3.error, "invalid_from_date");
  }
});

Deno.test("validateBillingWindow: rejects malformed to date with 400", () => {
  const res1 = validateBillingWindow("2026-01-01T00:00:00.000Z", "tomorrow");
  assertEquals(res1.ok, false);
  if (!res1.ok) {
    assertEquals(res1.status, 400);
    assertEquals(res1.error, "invalid_to_date");
  }

  const res2 = validateBillingWindow("2026-01-01T00:00:00.000Z", "");
  assertEquals(res2.ok, false);
  if (!res2.ok) {
    assertEquals(res2.status, 400);
    assertEquals(res2.error, "invalid_to_date");
  }
});

Deno.test("validateBillingWindow: rejects reversed or empty window (from >= to) with 400", () => {
  const resReversed = validateBillingWindow(
    "2026-06-15T00:00:00.000Z",
    "2026-06-10T00:00:00.000Z"
  );
  assertEquals(resReversed.ok, false);
  if (!resReversed.ok) {
    assertEquals(resReversed.status, 400);
    assertEquals(resReversed.error, "invalid_window_range");
  }

  const resEqual = validateBillingWindow(
    "2026-06-15T00:00:00.000Z",
    "2026-06-15T00:00:00.000Z"
  );
  assertEquals(resEqual.ok, false);
  if (!resEqual.ok) {
    assertEquals(resEqual.status, 400);
    assertEquals(resEqual.error, "invalid_window_range");
  }
});

Deno.test("validateBillingWindow: rejects window exceeding max allowed days with 400", () => {
  const from = new Date("2025-01-01T00:00:00.000Z");
  const to = new Date(from.getTime() + (MAX_BILLING_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);

  const res = validateBillingWindow(from.toISOString(), to.toISOString());
  assertEquals(res.ok, false);
  if (!res.ok) {
    assertEquals(res.status, 400);
    assertEquals(res.error, "window_too_large");
  }
});

Deno.test("GET /fees route: rejects unauthenticated requests with 401", async () => {
  const res = await billingApp.fetch(new Request("http://localhost/fees"));
  assertEquals(res.status, 401);
});

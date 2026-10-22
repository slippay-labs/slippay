import { Hono } from "hono";
import type { SupabaseClient } from "supabase";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { mapDbError } from "../lib/db-error.ts";

export const MAX_BILLING_WINDOW_DAYS = 366;
export const MAX_BILLING_WINDOW_MS = MAX_BILLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type BillingWindowResult =
  | { ok: true; from: Date; to: Date; fromIso: string; toIso: string }
  | { ok: false; error: string; detail: string; status: 400 };

/**
 * Validates and normalises the billing window from query parameters.
 * Rejects malformed dates, reversed windows, and windows exceeding MAX_BILLING_WINDOW_DAYS.
 */
export function validateBillingWindow(
  rawFrom?: string,
  rawTo?: string,
  now = new Date()
): BillingWindowResult {
  let fromDate: Date;
  let toDate: Date;

  if (rawFrom !== undefined) {
    if (!rawFrom.trim()) {
      return {
        ok: false,
        error: "invalid_from_date",
        detail: "Query parameter 'from' cannot be empty",
        status: 400,
      };
    }
    const parsed = new Date(rawFrom);
    if (isNaN(parsed.getTime())) {
      return {
        ok: false,
        error: "invalid_from_date",
        detail: "Query parameter 'from' must be a valid date",
        status: 400,
      };
    }
    fromDate = parsed;
  } else {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (rawTo !== undefined) {
    if (!rawTo.trim()) {
      return {
        ok: false,
        error: "invalid_to_date",
        detail: "Query parameter 'to' cannot be empty",
        status: 400,
      };
    }
    const parsed = new Date(rawTo);
    if (isNaN(parsed.getTime())) {
      return {
        ok: false,
        error: "invalid_to_date",
        detail: "Query parameter 'to' must be a valid date",
        status: 400,
      };
    }
    toDate = parsed;
  } else {
    toDate = now;
  }

  if (fromDate.getTime() >= toDate.getTime()) {
    return {
      ok: false,
      error: "invalid_window_range",
      detail: "'from' must be strictly before 'to'",
      status: 400,
    };
  }

  if (toDate.getTime() - fromDate.getTime() > MAX_BILLING_WINDOW_MS) {
    return {
      ok: false,
      error: "window_too_large",
      detail: `Billing window exceeds the maximum allowed range of ${MAX_BILLING_WINDOW_DAYS} days`,
      status: 400,
    };
  }

  return {
    ok: true,
    from: fromDate,
    to: toDate,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
  };
}

type Vars = { merchant: { id: string; platform_fee_bp?: number; [k: string]: unknown }; supabase: SupabaseClient };
const r = new Hono<{ Variables: Vars }>();

// Capture model A (off-chain invoice). Aggregates the per-order platform fee
// (persisted on each order as `fee_usdc`) into a billable total for a period —
// the data SlipPay invoices the merchant from. Read endpoint: dashboard (JWT)
// or API key. Default window = current calendar month.
//
// GET /v1/billing/fees?from=ISO&to=ISO
r.get("/fees", requireApiKeyOrJwt, async (c) => {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");

  const windowRes = validateBillingWindow(c.req.query("from"), c.req.query("to"));
  if (!windowRes.ok) {
    return c.json({ error: windowRes.error, detail: windowRes.detail }, windowRes.status);
  }

  const from = windowRes.fromIso;
  const to = windowRes.toIso;

  // Only paid orders are billable.
  const { data, error } = await sb
    .from("orders")
    .select("usdc_amount, fee_usdc, platform_fee_bp")
    .eq("merchant_id", merchant.id)
    .eq("status", "paid")
    .gte("paid_at", from)
    .lte("paid_at", to);
  if (error) { const m = mapDbError(error); return c.json({ error: m.code }, m.status as 400 | 409); }

  const rows = data ?? [];
  const sum = (k: string) => rows.reduce((a, o) => a + parseFloat((o as Record<string, string>)[k] ?? "0"), 0);
  const feeTotal = sum("fee_usdc");
  const grossTotal = sum("usdc_amount");

  return c.json({
    merchant_id: merchant.id,
    period: { from, to },
    orders_count: rows.length,
    gross_usdc: grossTotal.toFixed(7),
    fee_usdc_total: feeTotal.toFixed(7),     // what SlipPay invoices for the period
    net_usdc_total: (grossTotal - feeTotal).toFixed(7),
    platform_fee_bp: Number(merchant.platform_fee_bp ?? 98),
  });
});

export default r;

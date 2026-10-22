import { Hono } from "hono";
import type { SupabaseClient } from "supabase";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { mapDbError } from "../lib/db-error.ts";

type Vars = { merchant: { id: string; platform_fee_bp?: number; [k: string]: unknown }; supabase: SupabaseClient };
const r = new Hono<{ Variables: Vars }>();

export const MAX_BILLING_WINDOW_DAYS = 366;
export const MAX_BILLING_WINDOW_MS = MAX_BILLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type BillingValidationError = "invalid_from_date" | "invalid_to_date" | "invalid_window" | "window_too_large";

export function validateBillingWindow(
  rawFrom?: string,
  rawTo?: string,
  now = new Date()
): { valid: true; from: string; to: string } | { valid: false; error: BillingValidationError; message: string } {
  let fromDate: Date;
  if (rawFrom !== undefined) {
    fromDate = new Date(rawFrom);
    if (isNaN(fromDate.getTime())) {
      return { valid: false, error: "invalid_from_date", message: "from must be a valid date" };
    }
  } else {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  let toDate: Date;
  if (rawTo !== undefined) {
    toDate = new Date(rawTo);
    if (isNaN(toDate.getTime())) {
      return { valid: false, error: "invalid_to_date", message: "to must be a valid date" };
    }
  } else {
    toDate = now;
  }

  if (fromDate.getTime() >= toDate.getTime()) {
    return { valid: false, error: "invalid_window", message: "from must be strictly before to" };
  }

  if (toDate.getTime() - fromDate.getTime() > MAX_BILLING_WINDOW_MS) {
    return {
      valid: false,
      error: "window_too_large",
      message: `window exceeds maximum allowed period of ${MAX_BILLING_WINDOW_DAYS} days`,
    };
  }

  return {
    valid: true,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

// Capture model A (off-chain invoice). Aggregates the per-order platform fee
// (persisted on each order as `fee_usdc`) into a billable total for a period —
// the data SlipPay invoices the merchant from. Read endpoint: dashboard (JWT)
// or API key. Default window = current calendar month.
//
// GET /v1/billing/fees?from=ISO&to=ISO
r.get("/fees", requireApiKeyOrJwt, async (c) => {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");

  const windowCheck = validateBillingWindow(c.req.query("from"), c.req.query("to"));
  if (!windowCheck.valid) {
    return c.json({ error: windowCheck.error, message: windowCheck.message }, 400);
  }
  const { from, to } = windowCheck;

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

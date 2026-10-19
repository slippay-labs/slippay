import { Hono, type Context } from "hono";
import type { SupabaseClient } from "supabase";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { mapDbError } from "../lib/db-error.ts";

export const MAX_BILLING_WINDOW_DAYS = 366;
export const MAX_BILLING_WINDOW_MS = MAX_BILLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface BillingWindowValidation {
  ok: boolean;
  from?: string;
  to?: string;
  error?: string;
  status?: number;
  detail?: string;
}

/**
 * Parses and validates the billing date window (Issue #512).
 *
 * Rules:
 * 1. Malformed 'from' or 'to' values return 400 with specific error codes.
 * 2. Reversed or empty windows (from >= to) return 400.
 * 3. Windows longer than MAX_BILLING_WINDOW_DAYS (366 days) return 400.
 * 4. Defaults:
 *    - 'from': 1st day of current calendar month at 00:00:00.000 UTC.
 *    - 'to': current timestamp.
 */
export function validateBillingWindow(
  fromRaw?: string | null,
  toRaw?: string | null,
  now: Date = new Date()
): BillingWindowValidation {
  // Parse 'from'
  let fromDate: Date;
  if (fromRaw !== undefined && fromRaw !== null && fromRaw !== "") {
    const parsedFrom = parseValidDate(fromRaw);
    if (!parsedFrom) {
      return {
        ok: false,
        error: "malformed_from_date",
        status: 400,
        detail: `Parameter 'from' (${fromRaw}) is not a valid date`,
      };
    }
    fromDate = parsedFrom;
  } else {
    // Default to the first day of current calendar month (00:00:00.000 UTC)
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  // Parse 'to'
  let toDate: Date;
  if (toRaw !== undefined && toRaw !== null && toRaw !== "") {
    const parsedTo = parseValidDate(toRaw);
    if (!parsedTo) {
      return {
        ok: false,
        error: "malformed_to_date",
        status: 400,
        detail: `Parameter 'to' (${toRaw}) is not a valid date`,
      };
    }
    toDate = parsedTo;
  } else {
    toDate = now;
  }

  const fromTime = fromDate.getTime();
  const toTime = toDate.getTime();

  // Check reversed or empty window
  if (fromTime >= toTime) {
    return {
      ok: false,
      error: "reversed_billing_window",
      status: 400,
      detail: `Billing window is invalid: 'from' (${fromDate.toISOString()}) must be strictly before 'to' (${toDate.toISOString()})`,
    };
  }

  // Check window span
  if (toTime - fromTime > MAX_BILLING_WINDOW_MS) {
    return {
      ok: false,
      error: "billing_window_too_long",
      status: 400,
      detail: `Billing window exceeds maximum allowed range of ${MAX_BILLING_WINDOW_DAYS} days`,
    };
  }

  return {
    ok: true,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

function parseValidDate(val: string): Date | null {
  if (typeof val !== "string" || val.trim() === "") return null;
  const trimmed = val.trim();
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;

  // Protect against JS Date silent overflows like 2026-13-45 or 2026-02-31
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    const utcYear = d.getUTCFullYear();
    const utcMonth = d.getUTCMonth() + 1;
    const utcDay = d.getUTCDate();
    if (utcYear !== year || utcMonth !== month || utcDay !== day) {
      const localYear = d.getFullYear();
      const localMonth = d.getMonth() + 1;
      const localDay = d.getDate();
      if (localYear !== year || localMonth !== month || localDay !== day) {
        return null;
      }
    }
  }
  return d;
}

export type BillingVars = { merchant: { id: string; platform_fee_bp?: number; [k: string]: unknown }; supabase: SupabaseClient };
const r = new Hono<{ Variables: BillingVars }>();

// Capture model A (off-chain invoice). Aggregates the per-order platform fee
// (persisted on each order as `fee_usdc`) into a billable total for a period —
// the data SlipPay invoices the merchant from. Read endpoint: dashboard (JWT)
// or API key. Default window = current calendar month.
//
// GET /v1/billing/fees?from=ISO&to=ISO
export async function getFeesHandler(c: Context<{ Variables: BillingVars }>) {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");

  const windowResult = validateBillingWindow(c.req.query("from"), c.req.query("to"));
  if (!windowResult.ok) {
    return c.json({ error: windowResult.error, detail: windowResult.detail }, (windowResult.status ?? 400) as 400);
  }

  const { from, to } = windowResult;

  // Only paid orders are billable.
  const { data, error } = await sb
    .from("orders")
    .select("usdc_amount, fee_usdc, platform_fee_bp")
    .eq("merchant_id", merchant.id)
    .eq("status", "paid")
    .gte("paid_at", from!)
    .lte("paid_at", to!);
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
}

r.get("/fees", requireApiKeyOrJwt, getFeesHandler);

export default r;

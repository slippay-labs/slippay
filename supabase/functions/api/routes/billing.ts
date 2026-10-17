import { Hono } from "hono";
import type { SupabaseClient } from "supabase";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { mapDbError } from "../lib/db-error.ts";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

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

  const now = new Date();
  const defFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const from = c.req.query("from") ?? defFrom;
  const to = c.req.query("to") ?? now.toISOString();

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

  // Derive the fee rates actually applied to the orders covered by this report.
  // When a merchant's rate changes mid-period, the report preserves the per-order
  // rates rather than back-applying the merchant's current configuration.
  const fallbackBp = Number(merchant.platform_fee_bp ?? DEFAULT_PLATFORM_FEE_BP);
  const ratesApplied = Array.from(new Set(rows.map(o => {
    const bp = (o as Record<string, unknown>).platform_fee_bp;
    return bp != null ? Number(bp) : fallbackBp;
  }))).sort((a, b) => a - b);

  // Group orders into rate breakdowns for multi-rate or audit visibility
  const breakdown = (ratesApplied.length > 0 ? ratesApplied : [fallbackBp]).map((rate) => {
    const matchingRows = rows.filter((o) => {
      const bp = (o as Record<string, unknown>).platform_fee_bp;
      const effective = bp != null ? Number(bp) : fallbackBp;
      return effective === rate;
    });
    const subGross = matchingRows.reduce((a, o) => a + parseFloat((o as Record<string, string>).usdc_amount ?? "0"), 0);
    const subFee = matchingRows.reduce((a, o) => a + parseFloat((o as Record<string, string>).fee_usdc ?? "0"), 0);
    return {
      platform_fee_bp: rate,
      orders_count: matchingRows.length,
      gross_usdc: subGross.toFixed(7),
      fee_usdc: subFee.toFixed(7),
    };
  });

  // Effective platform_fee_bp: if exactly one rate was charged across the period,
  // report that rate; if zero orders, report current merchant config or DEFAULT_PLATFORM_FEE_BP;
  // if multiple rates occurred mid-period, report the primary rate and detail distinct rates in rates_applied.
  const primaryRate = ratesApplied.length === 1 ? ratesApplied[0]! : fallbackBp;

  return c.json({
    merchant_id: merchant.id,
    period: { from, to },
    orders_count: rows.length,
    gross_usdc: grossTotal.toFixed(7),
    fee_usdc_total: feeTotal.toFixed(7),     // what SlipPay invoices for the period
    net_usdc_total: (grossTotal - feeTotal).toFixed(7),
    platform_fee_bp: primaryRate,
    rates_applied: ratesApplied.length > 0 ? ratesApplied : [fallbackBp],
    breakdown,
  });
});

export default r;

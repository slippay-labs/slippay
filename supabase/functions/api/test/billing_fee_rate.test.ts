import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { req } from "./_helpers.ts";
import { serviceClient } from "../lib/supabase.ts";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

async function createMerchant(feeBp?: number) {
  const sb = serviceClient();
  const email = `m-billing-${crypto.randomUUID()}@slippay.test`;
  const { error: errCreate } = await sb.auth.admin.createUser({ email, email_confirm: true, password: "test-password-1234" });
  if (errCreate) throw errCreate;
  const { data: s, error: errSign } = await sb.auth.signInWithPassword({ email, password: "test-password-1234" });
  if (errSign) throw errSign;
  const create = await req("/v1/merchants", {
    method: "POST",
    headers: { authorization: `Bearer ${s.session!.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ display_name: "BillingTest", stellar_address: "G" + "A".repeat(55) }),
  });
  const m = await create.json();
  if (feeBp !== undefined) {
    await sb.from("merchants").update({ platform_fee_bp: feeBp }).eq("id", m.merchant.id);
    m.merchant.platform_fee_bp = feeBp;
  }
  return m;
}

Deno.test("GET /v1/billing/fees reports DEFAULT_PLATFORM_FEE_BP for merchant with no explicit override and zero orders (fixes #223)", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const m = await createMerchant();
  const res = await req("/v1/billing/fees", {
    headers: { authorization: `Bearer ${m.api_key}` },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.orders_count, 0);
  assertEquals(body.platform_fee_bp, DEFAULT_PLATFORM_FEE_BP);
  assert(body.platform_fee_bp !== 98, "Must not report the stale hardcoded 98 bp");
});

Deno.test("GET /v1/billing/fees reflects mid-period rate change across orders (fixes #223)", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const m = await createMerchant();
  const sb = serviceClient();
  const now = new Date();
  const paidAt = now.toISOString();

  // Insert two orders with different platform_fee_bp representing a mid-period rate change
  const order1Id = crypto.randomUUID();
  const order2Id = crypto.randomUUID();

  await sb.from("orders").insert([
    {
      id: order1Id,
      merchant_id: m.merchant.id,
      status: "paid",
      usdc_amount: "100.0000000",
      fee_usdc: "1.0000000",
      platform_fee_bp: 100, // old 1.00% rate
      paid_at: paidAt,
      memo: "a".repeat(64),
      customer_email: "c1@test.com",
    },
    {
      id: order2Id,
      merchant_id: m.merchant.id,
      status: "paid",
      usdc_amount: "200.0000000",
      fee_usdc: "5.9400000",
      platform_fee_bp: 297, // new 2.97% rate
      paid_at: paidAt,
      memo: "b".repeat(64),
      customer_email: "c2@test.com",
    },
  ]);

  const from = new Date(now.getTime() - 60000).toISOString();
  const to = new Date(now.getTime() + 60000).toISOString();

  const res = await req(`/v1/billing/fees?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    headers: { authorization: `Bearer ${m.api_key}` },
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.orders_count, 2);
  assertEquals(body.gross_usdc, "300.0000000");
  assertEquals(body.fee_usdc_total, "6.9400000");

  // Mid-period change: must distinguish both rates
  assert(Array.isArray(body.rates_applied), "rates_applied must be an array");
  assertEquals(body.rates_applied, [100, 297]);

  // Breakdown must provide detailed visibility for each rate
  assert(Array.isArray(body.breakdown), "breakdown must be an array");
  assertEquals(body.breakdown.length, 2);
  assertEquals(body.breakdown[0].platform_fee_bp, 100);
  assertEquals(body.breakdown[0].orders_count, 1);
  assertEquals(body.breakdown[1].platform_fee_bp, 297);
  assertEquals(body.breakdown[1].orders_count, 1);
});

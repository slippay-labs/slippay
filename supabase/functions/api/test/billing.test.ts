import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";
import { req } from "./_helpers.ts";
import { serviceClient } from "../lib/supabase.ts";

async function createTestMerchantWithKey(platformFeeBp?: number) {
  const sb = serviceClient();
  const email = `test-billing-${crypto.randomUUID()}@slippay.test`;
  const { data: userRecord, error: uErr } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,
    password: "test-password-1234",
  });
  if (uErr) throw uErr;

  const { data: session, error: sErr } = await sb.auth.signInWithPassword({
    email,
    password: "test-password-1234",
  });
  if (sErr) throw sErr;

  const jwt = session.session!.access_token;
  const createRes = await req("/v1/merchants", {
    method: "POST",
    headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: "Billing Test Merchant" }),
  });
  const createBody = await createRes.json();
  const apiKey = createBody.api_key;
  const merchantId = createBody.merchant.id;

  if (platformFeeBp !== undefined) {
    await sb.from("merchants").update({ platform_fee_bp: platformFeeBp }).eq("id", merchantId);
  }

  return { merchantId, apiKey, jwt };
}

Deno.test("GET /v1/billing/fees reports canonical DEFAULT_PLATFORM_FEE_BP (297) when unset (Issue #202)", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const { apiKey } = await createTestMerchantWithKey();
  const res = await req("/v1/billing/fees", {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.platform_fee_bp, DEFAULT_PLATFORM_FEE_BP);
  assertEquals(body.platform_fee_bp, 297);
});

Deno.test("GET /v1/billing/fees reports merchant platform_fee_bp override when set", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const { apiKey } = await createTestMerchantWithKey(150);
  const res = await req("/v1/billing/fees", {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.platform_fee_bp, 150);
});

Deno.test("No API route module contains hardcoded platform fee literals (Issue #202)", async () => {
  const routesDir = new URL("../routes", import.meta.url).pathname;
  for await (const entry of Deno.readDir(routesDir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      const code = await Deno.readTextFile(`${routesDir}/${entry.name}`);
      // Ensure no fallback uses hardcoded bare 98 for platform fee
      assert(
        !/platform_fee_bp\s*\?\?\s*98\b/.test(code),
        `Route ${entry.name} still contains hardcoded '?? 98' fallback for platform_fee_bp`,
      );
      // Ensure billing imports DEFAULT_PLATFORM_FEE_BP
      if (entry.name === "billing.ts") {
        assert(
          code.includes("DEFAULT_PLATFORM_FEE_BP"),
          "billing.ts must import and use DEFAULT_PLATFORM_FEE_BP",
        );
      }
    }
  }
});

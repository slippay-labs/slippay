import { Hono } from "hono";
import type { SupabaseClient } from "supabase";
import { CreateOrderInputSchema, UsdcAmountSchema, LimitQuerySchema, ORDER_DEFAULT_EXPIRY_MINUTES, DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";
import { requireApiKey } from "../middleware/auth_apikey.ts";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { generateMemo } from "../lib/memo.ts";
import { getBrlPerUsdc } from "../lib/rate.ts";
import { serviceClient } from "../lib/supabase.ts";
import { signCheckoutToken, verifyCheckoutToken } from "../lib/checkout-token.ts";
import { mapDbError } from "../lib/db-error.ts";

type Vars = { merchant: { id: string; [k: string]: unknown }; supabase: SupabaseClient };
const r = new Hono<{ Variables: Vars }>();

const CHECKOUT_BASE = Deno.env.get("CHECKOUT_BASE_URL") ?? "http://localhost:5173";

r.post("/", requireApiKey, async (c) => {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");
  let input: ReturnType<typeof CreateOrderInputSchema.parse>;
  try {
    input = CreateOrderInputSchema.parse(await c.req.json());
  } catch (e: unknown) {
    const issues = (e as { issues?: unknown }).issues ?? (e as { errors?: unknown }).errors ?? [];
    return c.json({ error: "validation_error", issues }, 400);
  }

  // USD-denominated path: USDC is USD-pegged 1:1, no CoinGecko round trip.
  // BRL-denominated path: convert via current BRL/USDC rate.
  let usdc: string;
  let brl_amount: string | null = null;
  let usd_amount: string | null = null;
  let rate_brl_usdc: string | null = null;

  if (input.usd_amount) {
    usd_amount = input.usd_amount;
    usdc = input.usd_amount;
  } else {
    brl_amount = input.brl_amount!;
    const rate = await getBrlPerUsdc();
    usdc = (parseFloat(input.brl_amount!) / rate).toFixed(7);
    rate_brl_usdc = rate.toFixed(7);
  }

  try {
    usdc = UsdcAmountSchema.parse(usdc);
  } catch (e: unknown) {
    const issues = (e as { issues?: unknown }).issues ?? (e as { errors?: unknown }).errors ?? [];
    return c.json({ error: "validation_error", issues }, 400);
  }

  const rawIdempotencyKey = c.req.header("idempotency-key")?.trim();
  const idempotencyKey = rawIdempotencyKey && rawIdempotencyKey.length > 0
    ? rawIdempotencyKey.slice(0, 128)
    : null;

  const findExistingOrder = async (): Promise<Record<string, unknown> | null> => {
    if (idempotencyKey) {
      const { data } = await sb
        .from("orders")
        .select("*")
        .eq("merchant_id", merchant.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (data) return data;
    }
    if (input.external_ref) {
      const { data } = await sb
        .from("orders")
        .select("*")
        .eq("merchant_id", merchant.id)
        .eq("external_ref", input.external_ref)
        .maybeSingle();
      if (data) return data;
    }
    return null;
  };

  // Idempotency pre-check: if order already exists under this idempotency-key or external_ref, replay it
  if (idempotencyKey || input.external_ref) {
    const existing = await findExistingOrder();
    if (existing) {
      const token = await signCheckoutToken(existing.id as string);
      const gross = existing.usdc_amount as string;
      const fee = existing.fee_usdc as string;
      const net = (existing.net_usdc as string | undefined) ?? (parseFloat(gross) - parseFloat(fee)).toFixed(7);
      return c.json({
        order: existing,
        checkout_url: `${CHECKOUT_BASE}/checkout/${existing.id}?t=${token}`,
        fee: {
          platform_fee_bp: existing.platform_fee_bp,
          gross_usdc: gross,
          fee_usdc: fee,
          net_usdc: net,
        },
        idempotent_replay: true,
      }, 200);
    }
  }

  let memo = await generateMemo();
  const minutes = input.expires_in_minutes ?? ORDER_DEFAULT_EXPIRY_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

  // Platform fee. `usdc` (gross) is what the buyer pays; merchant net = gross −
  // fee; fee_usdc is SlipPay's 0.98% cut, persisted per order so capture model A
  // (off-chain invoice) has a ledger to bill from. Persisting is the accounting —
  // capture routes fee_usdc to SlipPay via the monthly invoice.
  const feeBp = Number((merchant as { platform_fee_bp?: number }).platform_fee_bp ?? DEFAULT_PLATFORM_FEE_BP);
  const grossUsdc = parseFloat(usdc);
  const feeUsdc = (grossUsdc * feeBp / 10_000).toFixed(7);
  const netUsdc = (grossUsdc - parseFloat(feeUsdc)).toFixed(7);

  const insertPayload = (m: string) => ({
    merchant_id: merchant.id,
    merchant_stellar_address: merchant.stellar_address ?? null,
    external_ref: input.external_ref ?? null,
    idempotency_key: idempotencyKey,
    brl_amount,
    usd_amount,
    usdc_amount: usdc,
    rate_brl_usdc,
    memo: m,
    expires_at: expiresAt,
    platform_fee_bp: feeBp,
    fee_usdc: feeUsdc,
    net_usdc: netUsdc,
  });

  let insertRes = await sb.from("orders").insert(insertPayload(memo)).select("*").single();

  // Collision handling (23505 unique constraint violation):
  if (insertRes.error && (insertRes.error as { code?: string }).code === "23505") {
    // 1. Check if collision was caused by concurrent double-submit with same idempotency_key or external_ref
    if (idempotencyKey || input.external_ref) {
      const existingAfterRace = await findExistingOrder();
      if (existingAfterRace) {
        const token = await signCheckoutToken(existingAfterRace.id as string);
        const gross = existingAfterRace.usdc_amount as string;
        const fee = existingAfterRace.fee_usdc as string;
        const net = (existingAfterRace.net_usdc as string | undefined) ?? (parseFloat(gross) - parseFloat(fee)).toFixed(7);
        return c.json({
          order: existingAfterRace,
          checkout_url: `${CHECKOUT_BASE}/checkout/${existingAfterRace.id}?t=${token}`,
          fee: {
            platform_fee_bp: existingAfterRace.platform_fee_bp,
            gross_usdc: gross,
            fee_usdc: fee,
            net_usdc: net,
          },
          idempotent_replay: true,
        }, 200);
      }
    }

    // 2. Otherwise it's a memo collision — retry once with fresh memo
    memo = await generateMemo();
    insertRes = await sb.from("orders").insert(insertPayload(memo)).select("*").single();
  }

  const { data, error } = insertRes;
  if (error) return c.json({ error: "create_failed" }, 400);
  const token = await signCheckoutToken(data.id as string);

  return c.json({
    order: data,
    checkout_url: `${CHECKOUT_BASE}/checkout/${data.id}?t=${token}`,
    fee: {
      platform_fee_bp: feeBp,
      gross_usdc: usdc,
      fee_usdc: feeUsdc,
      net_usdc: netUsdc,
    },
  }, 201);
});

r.get("/", requireApiKeyOrJwt, async (c) => {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");
  const status = c.req.query("status");
  const limit = LimitQuerySchema.parse(c.req.query("limit"));
  let q = sb.from("orders").select("*").eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    const m = mapDbError(error);
    return c.json({ error: m.code }, m.status as 400 | 409);
  }
  const orders = (data ?? []).map((o: Record<string, unknown>) => ({
    ...o,
    brl_amount: typeof o.brl_amount === "number"
      ? o.brl_amount.toFixed(2)
      : o.brl_amount,
  }));
  return c.json({ orders });
});

// Audit-004 · C2: this endpoint is reached by the customer's browser during
// checkout, so it cannot require an API key. Instead, the order creator gets
// a signed `?t=` token at order creation, and the customer can only read the
// order if they have the token. Without it: 401. PII fields that the checkout
// page does NOT need (merchant_id, external_ref, tx_hash) are stripped from
// the response so a leaked token only reveals what the customer already needs
// to pay.
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("t") ?? "";
  const ok = await verifyCheckoutToken(id, token);
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  const { data, error } = await sb.from("orders")
    .select(`
      id, brl_amount, usd_amount, usdc_amount, memo, status,
      expires_at, paid_at, created_at,
      merchant_stellar_address
    `)
    .eq("id", id).maybeSingle();
  if (error || !data) return c.json({ error: "not_found" }, 404);
  // Serve the PINNED recipient (snapshotted at creation), not a live merchant
  // lookup — so the address the buyer pays cannot drift after consent.
  return c.json({ order: data });
});

r.post("/:id/cancel", requireApiKey, async (c) => {
  const merchant = c.get("merchant");
  const sb = c.get("supabase");
  const id = c.req.param("id");
  const { data, error } = await sb.from("orders")
    .update({ status: "cancelled" })
    .eq("id", id).eq("merchant_id", merchant.id).eq("status", "pending")
    .select("*").maybeSingle();
  if (error || !data) return c.json({ error: "cannot_cancel" }, 400);
  return c.json({ order: data });
});

export default r;

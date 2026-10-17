import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { SupabaseClient } from "supabase";
import { CreateOrderInputSchema, UsdcAmountSchema, LimitQuerySchema, ORDER_DEFAULT_EXPIRY_MINUTES, DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";
import { requireApiKey } from "../middleware/auth_apikey.ts";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";
import { generateMemo } from "../lib/memo.ts";
import { getBrlPerUsdc, RateUnavailableError } from "../lib/rate.ts";
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
    try {
      const rate = await getBrlPerUsdc();
      usdc = (parseFloat(input.brl_amount!) / rate).toFixed(7);
      rate_brl_usdc = rate.toFixed(7);
    } catch (err: unknown) {
      if (err instanceof RateUnavailableError || (err as { code?: string })?.code === "rate_unavailable") {
        c.header("Retry-After", "5");
        return c.json({
          error: "rate_unavailable",
          message: "Upstream FX rate service temporarily unavailable. Please retry shortly.",
        }, 503);
      }
      throw err;
    }
  }

  try {
    usdc = UsdcAmountSchema.parse(usdc);
  } catch (e: unknown) {
    const issues = (e as { issues?: unknown }).issues ?? (e as { errors?: unknown }).errors ?? [];
    return c.json({ error: "validation_error", issues }, 400);
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
    brl_amount,
    usd_amount,
    usdc_amount: usdc,
    rate_brl_usdc,
    memo: m,
    expires_at: expiresAt,
    platform_fee_bp: feeBp,
    fee_usdc: feeUsdc,
  });

  let insertRes = await sb.from("orders").insert(insertPayload(memo)).select("*").single();
  // Audit #71: Explicit collision retry for unique memo constraint
  if (insertRes.error && (insertRes.error as { code?: string }).code === "23505") {
    memo = await generateMemo();
    insertRes = await sb.from("orders").insert(insertPayload(memo)).select("*").single();
  }

  const { data, error } = insertRes;
  if (error) return c.json({ error: "create_failed" }, 400);
  const token = await signCheckoutToken(data.id as string, data.expires_at ?? expiresAt);

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

// Audit-004 · C2 / Issue #206: One-time token exchange endpoint.
// Exchanges the query token ?t= for an HttpOnly, Secure, SameSite cookie,
// then redirects (303 See Other) to strip ?t= from the customer's browser URL.
r.get("/:id/exchange", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("t") ?? "";
  const ok = await verifyCheckoutToken(id, token);
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  setCookie(c, `checkout_token_${id}`, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 3600,
  });
  c.header("Referrer-Policy", "no-referrer");

  const redirectTarget = c.req.query("redirect") ?? `${CHECKOUT_BASE}/checkout/${id}`;
  return c.redirect(redirectTarget, 303);
});

// Audit-004 · C2 & Issue #206: this endpoint is reached by the customer's browser during
// checkout, so it cannot require an API key. To prevent bearer token leakage via URLs
// (Referer headers, browser history, reverse proxy logs), this endpoint accepts the token
// via an HttpOnly, Secure cookie (scoped to checkout path) or via ?t= on first exchange.
// When passed via ?t=, it immediately sets the credential cookie so subsequent reads carry
// no credential in the URL. A naked/captured URL without the cookie returns 401.
// PII fields that the checkout page does NOT need (merchant_id, external_ref, tx_hash)
// are stripped from the response so a leaked token only reveals what the customer already
// needs to pay.
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  const cookieName = `checkout_token_${id}`;
  const cookieToken = getCookie(c, cookieName) ?? getCookie(c, "checkout_token");
  const queryToken = c.req.query("t");
  const authHeader = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

  const token = cookieToken || queryToken || authHeader || "";
  const ok = await verifyCheckoutToken(id, token);
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  // If presented via query parameter (first visit / exchange), set HttpOnly cookie
  if (queryToken && !cookieToken) {
    setCookie(c, cookieName, queryToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 3600,
    });
  }

  // Ensure Referrer-Policy: no-referrer prevents order id / token leakage to embedded resources
  c.header("Referrer-Policy", "no-referrer");

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

/*
 * E2E - Plan B Task 12
 *
 * Exercises the full payment lifecycle without a browser:
 *   1. Reads fresh keypairs from /tmp/e2e-keys.json (set up by globalSetup.e2e.ts)
 *   2. Creates a test merchant in DB (via API with JWT)
 *   3. Creates an order via API (using merchant's api_key)
 *   4. Builds the atomic USDC payment tx and submits to Horizon
 *   5. Starts watchAccount in-process (no separate listener process needed)
 *   6. Asserts order.status === "paid", tx_hash populated, webhook_deliveries row exists
 *
 * Run: pnpm --filter @slippay/listener e2e
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional env: API_BASE (defaults to SUPABASE_URL_functions/v1/api)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createClient } from "@supabase/supabase-js";
import { watchAccount } from "../src/horizon.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const API_BASE = process.env.API_BASE ?? `${SUPABASE_URL}/functions/v1/api`;

// Guard: skip the entire suite when not running via the e2e config.
// The unit-test runner does not set SUPABASE_SERVICE_ROLE_KEY, so this
// prevents the describe block's beforeAll from failing in normal `pnpm test` runs.
const isE2ERun = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

// Lazily initialized in beforeAll after env check.
// sb = used for auth admin operations (createUser, signIn).
// dbAdmin = pure service-role client for listener + assertions.
// These MUST be separate: calling sb.auth.signInWithPassword changes sb's session
// which would cause subsequent sb requests to use the user JWT instead of service role,
// causing RLS violations on insert.
let sb: ReturnType<typeof createClient>;
let dbAdmin: ReturnType<typeof createClient>;
const horizon = new Horizon.Server(HORIZON_URL);

// Read keypairs written by globalSetup
let buyer: Keypair;
let merchant: Keypair;
let platform: Keypair;
let issuer: Keypair;
let usdc: Asset;

describe.skipIf(!isE2ERun)("E2E: testnet payment lifecycle", () => {
  let orderId: string;
  let memoHex: string;
  let usdcAmount: string;
  let stopWatcher: (() => void) | undefined;
  let apiKey: string;
  let merchantId: string;

  beforeAll(async () => {
    if (!SUPABASE_SR) throw new Error("SUPABASE_SERVICE_ROLE_KEY required for e2e test");
    // sb is used for auth operations (admin.createUser, signInWithPassword)
    sb = createClient(SUPABASE_URL, SUPABASE_SR, { auth: { persistSession: false } });
    // dbAdmin is a SEPARATE service-role client used for listener + DB assertions.
    // Never call auth.signIn* on this one — that would downgrade it to user JWT.
    dbAdmin = createClient(SUPABASE_URL, SUPABASE_SR, { auth: { persistSession: false } });

    // Load keypairs from globalSetup output
    const keys = JSON.parse(readFileSync("/tmp/e2e-keys.json", "utf-8"));
    buyer = Keypair.fromSecret(keys.buyer.secretKey);
    merchant = Keypair.fromSecret(keys.merchant.secretKey);
    platform = Keypair.fromSecret(keys.platform.secretKey);
    issuer = Keypair.fromSecret(keys.issuer.secretKey);
    usdc = new Asset("USDC", issuer.publicKey());

    console.log(`[e2e] buyer:    ${buyer.publicKey()}`);
    console.log(`[e2e] merchant: ${merchant.publicKey()}`);
    console.log(`[e2e] platform: ${platform.publicKey()}`);
    console.log(`[e2e] issuer:   ${issuer.publicKey()}`);

    // Create a test user + merchant via auth admin API
    const email = `e2e-${Date.now()}@slippay.test`;
    const password = "p1234567890!";

    console.log("[e2e] creating auth user...");
    const { data: userData, error: userError } = await sb.auth.admin.createUser({
      email,
      email_confirm: true,
      password,
    });
    if (userError || !userData.user) {
      throw new Error(`createUser failed: ${userError?.message}`);
    }

    console.log("[e2e] signing in...");
    const { data: session, error: signInError } = await sb.auth.signInWithPassword({ email, password });
    if (signInError || !session.session) {
      throw new Error(`signIn failed: ${signInError?.message}`);
    }
    const jwt = session.session.access_token;

    console.log("[e2e] creating merchant...");
    const createMerchantRes = await fetch(`${API_BASE}/v1/merchants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: "E2E Smoke Test",
        stellar_address: merchant.publicKey(),
      }),
    });
    const merchantBody = await createMerchantRes.json();
    if (!merchantBody.api_key) {
      throw new Error(`merchant create failed: ${JSON.stringify(merchantBody)}`);
    }
    expect(merchantBody.api_key).toMatch(/^sk_live_/);
    apiKey = merchantBody.api_key as string;
    merchantId = merchantBody.merchant.id as string;
    console.log(`[e2e] merchant created id=${merchantId}`);

    // Create an order
    console.log("[e2e] creating order...");
    const orderRes = await fetch(`${API_BASE}/v1/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ brl_amount: "10.00" }),
    });
    const orderBody = await orderRes.json();
    if (!orderBody.order?.id) {
      throw new Error(`order create failed: ${JSON.stringify(orderBody)}`);
    }
    orderId = orderBody.order.id as string;
    memoHex = orderBody.order.memo as string;
    usdcAmount = orderBody.order.usdc_amount as string;
    console.log(`[e2e] order created id=${orderId} memo=${memoHex} usdc=${usdcAmount}`);

    // Start in-process listener watching the merchant account
    console.log(`[e2e] starting watchAccount for merchant ${merchant.publicKey()}...`);
    stopWatcher = await watchAccount({
      db: dbAdmin,
      network: "TESTNET",
      accountId: merchant.publicKey(),
    });
    console.log("[e2e] watcher started");
  }, 120_000);

  afterAll(() => {
    if (stopWatcher) {
      stopWatcher();
      console.log("[e2e] watcher stopped");
    }
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async function createOrder(brlAmount = "10.00"): Promise<{ id: string; memo: string; usdc_amount: string }> {
    const res = await fetch(`${API_BASE}/v1/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ brl_amount: brlAmount }),
    });
    const body = await res.json();
    if (!body.order?.id) {
      throw new Error(`order create failed: ${JSON.stringify(body)}`);
    }
    return {
      id: body.order.id as string,
      memo: body.order.memo as string,
      usdc_amount: body.order.usdc_amount as string,
    };
  }

  async function fetchOrder(id: string): Promise<{ status: string; tx_hash: string | null }> {
    const res = await fetch(`${API_BASE}/v1/orders/${id}`);
    const body = await res.json();
    return body.order;
  }

  async function waitForStatus(id: string, expected: string, timeoutMs = 90_000): Promise<{ status: string; tx_hash: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last: { status: string; tx_hash: string | null } | undefined;
    while (Date.now() < deadline) {
      last = await fetchOrder(id);
      if (last.status === expected) return last;
      await new Promise(res => setTimeout(res, 2000));
    }
    throw new Error(`timeout waiting for order ${id} to reach ${expected} (last=${JSON.stringify(last)})`);
  }

  async function submitPayment(memo: string, merchantShare: string, feeShare: string): Promise<string> {
    const buyerAcc = await horizon.loadAccount(buyer.publicKey());
    const memoBytes = Buffer.from(memo, "hex");
    expect(memoBytes.length).toBe(32);

    const tx = new TransactionBuilder(
      new Account(buyer.publicKey(), buyerAcc.sequence),
      {
        fee: BASE_FEE,
        networkPassphrase: PASSPHRASE,
        memo: Memo.hash(memoBytes),
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
      },
    )
      .addOperation(
        Operation.payment({
          destination: merchant.publicKey(),
          asset: usdc,
          amount: merchantShare,
        }),
      )
      .addOperation(
        Operation.payment({
          destination: platform.publicKey(),
          asset: usdc,
          amount: feeShare,
        }),
      )
      .build();

    tx.sign(buyer);
    const submitted = await horizon.submitTransaction(tx);
    expect((submitted as { successful: boolean }).successful).toBe(true);
    return (submitted as { hash: string }).hash;
  }

  async function getWebhooks(orderId: string) {
    const { data, error } = await dbAdmin
      .from("webhook_deliveries")
      .select("*")
      .eq("order_id", orderId);
    expect(error).toBeNull();
    return data ?? [];
  }

  async function getCreditsForOrder(orderId: string) {
    const { data, error } = await dbAdmin
      .from("ledger_entries")
      .select("*")
      .eq("order_id", orderId);
    expect(error).toBeNull();
    return data ?? [];
  }

  // --------------------------------------------------------------------------
  // Matrix
  // --------------------------------------------------------------------------

  it("paid: matching payment transitions to paid, credits, webhook", async () => {
    const order = await createOrder("10.00");
    const total = Number(order.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = (total - fee).toFixed(7);
    const feeShare = fee.toFixed(7);

    const txHash = await submitPayment(order.memo, merchantShare, feeShare);
    const final = await waitForStatus(order.id, "paid");
    expect(final.tx_hash).toBeTruthy();
    expect(final.tx_hash).toBe(
txHash);

    const credits = await getCreditsForOrder(order.id);
    expect(credits.length).toBe1();

    const webhooks = await getWebhooks(order.id);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].type).toBe("order.paid");
  }, 180_000);

  it("underpaid: partial payment marks underpaid, no credit, webhook", async () => {
    const order = await createOrder("10.00");
    const total = Number(order.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = ((total - fee) * 0.5).toFixed(7);
    const feeLight = (fee * 0.5).toFixed(7);

    await submitPayment(order.memo, merchantShare, feeLight);
    const final = await waitForStatus(order.id, "underpaid");
    expect(final.tx_hash).toBeTruthy();

    const credits = await getCreditsForOrder(order.id);
    expect(credits.length).toBe(0);

    const webhooks = await getWebhooks(order.id);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].type).toBe("order.underpaid");
  }, 180_000);

  it("expired: payment for expired order does not double credit", async () => {
    const order = await createOrder("10.00");
    // Expire the order directly in DB before payment arrives.
    const { error } = await dbAdmin
      .from("orders")
      .update({ status: "expired" })
      .eq("id", order.id);
    expect(error).toBeNull();

    const total = Number(orde.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = (total - fee).toFixed(7);
    const feeShare = fee.toFixed(7);

    await submitPayment(order.memo, merchantShare, feeShare);
    // Wait a bit for the listener to process the tx.
    await new Promise(res => setTimeout(res, 15_000));

    const final = await fetchOrder(order.id);
    expect(final.status).toBe("expired");

    const credits = await getCreditsForOrder(order.id);
    expect(credits.length).toBe(0);
  }, 180_000);

  it("cancelled: payment for cancelled order is ignored", async () => {
    const order = await createOrder("10.00");
    const { error } = await dbAdmin
      .from("orders")
      .update({ status: "cancelled" })
      .eq("id", order.id);
    expect(error).toBeNull();

    const total = Number(order.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = (total - fee).toFixed(7);
    const feeShare = fee.toFixed(7);

    await submitPayment(order.memo, merchantShare, feeStare);
    await new Promise(res => setTimeout(res, 15_000));

    const final = await fetchOrder(order.id);
    expect(final.status).toBe("cancelled");

    const credits = await getCreditsForOrder(order.id);
    expect(credits.length).toBe(0);
  }, 180_000);

  it("duplicate: second payment for paid order does not double credit", async () => {
    const order = await createOrder("10.00");
    const total = Number(order.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = (total - fee).toFixed(7);
    const feeShare = fee.toFixed(7);

    await submitPayment(order.memo, merchantShare, feeShare);
    await waitForStatus(order.id, "paid");

    const creditsBefore = await getCreditsForOrder(order.id);
    expect(creditsBefore.length).toBe(1);

    // Duplicate payment with the same memo.
    await submitPayment(order.memo, merchantShare, feeShare);
    await new Promise(res => setTimeout(res, 15_000));

    const final = await fetchOrder(order.id);
    expect(final.status).toBe("paid");

    const creditsAfter = await getCreditsForOrder(order.id);
    expect(creditsAfter.length).toBe(creditsBefore.length);
  }, 180_000);

  it("overpayment: overpayment marks paid and credits", async () => {
    const order = await createOrder("10.00");
    const total = Number(order.usdc_amount);
    const fee = total * (100 / 10_000);
    const merchantShare = ((total - fee) * 1.1).toFixed(7);
    const feeShare = (fee * 1.1).toFixed(7);

    await submitPayment(order.memo, merchantShare, feeShare);
    const final = await waitForStatus(order.id, "paid");
    expect(final.tx_hash).toBeTruthy();

    const credits = await getCreditsForOrder(order.id);
    expect(credits.length).toBe1();

    const webhooks = await getWebhooks(order.id);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].type).toBe("order.paid");
  }, 180_000);
});

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fourpApp from "../routes/fourp.ts";
import { FourPClient, FourPError } from "../lib/fourp/client.ts";

const ALLOWED_ORIGIN = "https://app.slippay.cc";

// ── 1. Dormant without FOURP_API_KEY ─────────────────────────────────────────

Deno.test("fourp: GET /status reports enabled: false when FOURP_API_KEY is unset", async () => {
  Deno.env.delete("FOURP_API_KEY");
  const res = await fourpApp.request("/status");
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json, { enabled: false });
});

Deno.test("fourp: routes fail-closed with 503 ramp_disabled when FOURP_API_KEY is unset", async () => {
  Deno.env.delete("FOURP_API_KEY");

  // POST /webhook
  const whRes = await fourpApp.request("/webhook", { method: "POST" });
  assertEquals(whRes.status, 503);
  assertEquals(await whRes.json(), { error: "ramp_disabled" });

  // POST /quote
  const quoteRes = await fourpApp.request("/quote", {
    method: "POST",
    headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ amountBrl: 100 }),
  });
  assertEquals(quoteRes.status, 503);
  assertEquals(await quoteRes.json(), { error: "ramp_disabled" });

  // POST /onramp
  const onrampRes = await fourpApp.request("/onramp", {
    method: "POST",
    headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      amountBrl: 100,
      receiverWallet: "0x123",
      email: "test@example.com",
      cpf: "12345678901",
    }),
  });
  assertEquals(onrampRes.status, 503);
  assertEquals(await onrampRes.json(), { error: "ramp_disabled" });

  // POST /offramp
  const offrampRes = await fourpApp.request("/offramp", {
    method: "POST",
    headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      amountUsdc: 50,
      pixKey: "test@example.com",
      senderWallet: "0x123",
      email: "test@example.com",
      cpf: "12345678901",
    }),
  });
  assertEquals(offrampRes.status, 503);
  assertEquals(await offrampRes.json(), { error: "ramp_disabled" });

  // GET /offramp/:id
  const getOfframpRes = await fourpApp.request("/offramp/sample-tx", {
    method: "GET",
    headers: { origin: ALLOWED_ORIGIN },
  });
  assertEquals(getOfframpRes.status, 503);
  assertEquals(await getOfframpRes.json(), { error: "ramp_disabled" });
});

// ── 2. Receiver-Pinning Fail-Closed Security Assertion ─────────────────────────

Deno.test("fourp offramp: rejects and aborts with 502 receiver_mismatch when returned receiver does not match pinned address", async () => {
  Deno.env.set("FOURP_API_KEY", "test-api-key");
  const PINNED = "0xE669C6Fe0493044D085C3cD08fb0289b53fA4449";
  Deno.env.set("FOURP_OFFRAMP_RECEIVER", PINNED);

  const origFetch = globalThis.fetch;
  // Mock 4P returning a hijacked or divergent receiver wallet address
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          http_code: 200,
          success: true,
          details: {
            data: {
              txid: "4p-tx-999",
              amount_crypto: 50,
              asset: "USDC",
              chain: "Base",
              amount_brl: 275.5,
              receiver_wallet: "0xAttackerOrMismatchedAddress1234567890",
              expires: 1800,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const res = await fourpApp.request("/offramp", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        amountUsdc: 50,
        pixKey: "user@pix.com",
        senderWallet: "0xSender123",
        email: "user@example.com",
        cpf: "12345678901",
      }),
    });

    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "receiver_mismatch");
    assertEquals(body.message, "4P receiver did not match the pinned address");
  } finally {
    globalThis.fetch = origFetch;
    Deno.env.delete("FOURP_API_KEY");
    Deno.env.delete("FOURP_OFFRAMP_RECEIVER");
  }
});

Deno.test("fourp offramp: succeeds with 201 when returned receiver matches pinned address (case-insensitive)", async () => {
  Deno.env.set("FOURP_API_KEY", "test-api-key");
  const PINNED = "0xE669C6Fe0493044D085C3cD08fb0289b53fA4449";
  Deno.env.set("FOURP_OFFRAMP_RECEIVER", PINNED);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          http_code: 200,
          success: true,
          details: {
            data: {
              txid: "4p-tx-1000",
              amount_crypto: 50,
              asset: "USDC",
              chain: "Base",
              amount_brl: 275.5,
              receiver_wallet: PINNED.toLowerCase(), // case-insensitive check
              expires: 1800,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const res = await fourpApp.request("/offramp", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        amountUsdc: 50,
        pixKey: "user@pix.com",
        senderWallet: "0xSender123",
        email: "user@example.com",
        cpf: "12345678901",
        customId: "slp-test-match-1",
      }),
    });

    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.id, "slp-test-match-1");
    assertEquals(body.receiver, PINNED.toLowerCase());
  } finally {
    globalThis.fetch = origFetch;
    Deno.env.delete("FOURP_API_KEY");
    Deno.env.delete("FOURP_OFFRAMP_RECEIVER");
  }
});

// ── 3. FourPClient Error Handling, Malformed Responses & Timeouts ─────────────

Deno.test("FourPClient: maps provider errors with http_code and details.message", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          http_code: 422,
          success: false,
          details: { message: "insufficient_liquidity_for_pair" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const client = new FourPClient({ apiKey: "key", baseUrl: "https://api.4p.finance" });
    const err = await assertRejects(
      () => client.quote("100"),
      FourPError,
      "insufficient_liquidity_for_pair",
    );
    assertEquals((err as FourPError).statusCode, 422);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("FourPClient: handles malformed non-JSON response gracefully", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response("<html>Bad Gateway 502</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
  }) as typeof fetch;

  try {
    const client = new FourPClient({ apiKey: "key", baseUrl: "https://api.4p.finance" });
    const err = await assertRejects(
      () => client.quote("100"),
      FourPError,
      "4P non-json response (502)",
    );
    assertEquals((err as FourPError).statusCode, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("FourPClient: maps network failures and timeouts to 502 FourPError", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.reject(new Error("connect ETIMEDOUT 44.196.63.157:443"));
  }) as typeof fetch;

  try {
    const client = new FourPClient({ apiKey: "key", baseUrl: "https://api.4p.finance" });
    const err = await assertRejects(
      () => client.quote("100"),
      FourPError,
      "4P network error: connect ETIMEDOUT",
    );
    assertEquals((err as FourPError).statusCode, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

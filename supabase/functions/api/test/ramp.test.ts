import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resetRampProvider, applyMargin, getRampMarginBps, getRampProvider, isRampEnabled } from "../lib/ramp/index.ts";
import { EtherfuseClient } from "../lib/ramp/etherfuse/index.ts";
import { AnchorError } from "../lib/ramp/types.ts";
import { CnopApi, CnopApiError } from "../lib/ramp/criptopix/api.ts";

// ---- factory: dormant unless explicitly enabled + keyed --------------------

Deno.test("ramp provider is null when ETHERFUSE_ENABLED is unset", () => {
  Deno.env.delete("ETHERFUSE_ENABLED");
  Deno.env.delete("ETHERFUSE_API_KEY");
  _resetRampProvider();
  assertEquals(getRampProvider(), null);
  assertEquals(isRampEnabled(), false);
});

Deno.test("ramp provider is null when enabled but no API key", () => {
  Deno.env.set("ETHERFUSE_ENABLED", "1");
  Deno.env.delete("ETHERFUSE_API_KEY");
  _resetRampProvider();
  assertEquals(getRampProvider(), null);
});

Deno.test("ramp provider activates with ETHERFUSE_ENABLED=1 + key", () => {
  Deno.env.set("ETHERFUSE_ENABLED", "1");
  Deno.env.set("ETHERFUSE_API_KEY", "test-key");
  _resetRampProvider();
  const p = getRampProvider();
  assertEquals(p?.name, "etherfuse");
  assertEquals(p?.supportedCurrencies.includes("BRL"), true);
  assertEquals(p?.supportedRails.includes("pix"), true);
  Deno.env.delete("ETHERFUSE_ENABLED");
  Deno.env.delete("ETHERFUSE_API_KEY");
  _resetRampProvider();
});

// ---- margin: Slippay's spread embedded in every quote ----------------------

Deno.test("ramp margin defaults to 190 bps (1.9%)", () => {
  Deno.env.delete("SLIPPAY_RAMP_MARGIN_BPS");
  assertEquals(getRampMarginBps(), 190);
});

Deno.test("ramp margin is env-overridable, capped at 1000 bps", () => {
  Deno.env.set("SLIPPAY_RAMP_MARGIN_BPS", "250");
  assertEquals(getRampMarginBps(), 250);
  Deno.env.set("SLIPPAY_RAMP_MARGIN_BPS", "9999"); // over cap -> default
  assertEquals(getRampMarginBps(), 190);
  Deno.env.delete("SLIPPAY_RAMP_MARGIN_BPS");
});

Deno.test("applyMargin embeds the spread, both directions", () => {
  Deno.env.delete("SLIPPAY_RAMP_MARGIN_BPS"); // 1.9%
  // off-ramp: 534.6 BRL out -> 1.9% margin
  const off = applyMargin({ toAmount: "534.6", toCurrency: "BRL" });
  assertEquals(off.grossToAmount, "534.6");
  assertEquals(off.platformFeeBps, 190);
  assertEquals(off.platformFee, "10.1574");
  assertEquals(off.toAmount, "524.4426");
  // on-ramp: 100 USDC out -> same spread applies
  const on = applyMargin({ toAmount: "100", toCurrency: "USDC" });
  assertEquals(on.toAmount, "98.1");
  assertEquals(on.platformFee, "1.9");
});

// ---- client: USDC -> BRL off-ramp quote, mapped from the Etherfuse API ------

Deno.test("EtherfuseClient.getQuote resolves USDC and maps an off-ramp quote", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/ramp/assets")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            assets: [{
              symbol: "USDC",
              identifier:
                "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              name: "USD Coin",
              currency: "usd",
              balance: null,
              image: null,
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/ramp/quote")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            quoteId: "q1",
            customerId: "c1",
            blockchain: "stellar",
            quoteAssets: {
              type: "offramp",
              sourceAsset:
                "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              targetAsset: "BRL",
            },
            sourceAmount: "100",
            destinationAmount: "540",
            exchangeRate: "5.40",
            feeBps: "100",
            feeAmount: "5.4",
            destinationAmountAfterFee: "534.6",
            createdAt: "2026-06-07T00:00:00Z",
            updatedAt: "2026-06-07T00:00:00Z",
            expiresAt: "2026-06-07T00:10:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  try {
    const client = new EtherfuseClient({
      apiKey: "k",
      baseUrl: "https://api.sand.etherfuse.com",
      defaultBlockchain: "stellar",
    });
    const q = await client.getQuote({
      fromCurrency: "USDC",
      toCurrency: "BRL",
      fromAmount: "100",
      stellarAddress: "GABC",
    });
    assertEquals(q.id, "q1");
    assertEquals(q.toCurrency, "BRL");
    assertEquals(q.fromAmount, "100");
    assertEquals(q.toAmount, "534.6"); // destinationAmountAfterFee wins
    assertEquals(q.fee, "5.4");
  } finally {
    globalThis.fetch = orig;
  }
});

// ---- EtherfuseClient error, malformed response and timeout coverage ---------

Deno.test("EtherfuseClient maps API errors to AnchorError with code and status", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: "MINIMUM_AMOUNT_NOT_MET",
            message: "Amount must be at least 10 USDC",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const client = new EtherfuseClient({
      apiKey: "k",
      baseUrl: "https://api.sand.etherfuse.com",
    });
    const err = await assertRejects(
      () => client.getQuote({ fromCurrency: "USDC", toCurrency: "BRL", fromAmount: "1" }),
      AnchorError,
      "Amount must be at least 10 USDC",
    );
    assertEquals((err as AnchorError).code, "MINIMUM_AMOUNT_NOT_MET");
    assertEquals((err as AnchorError).statusCode, 400);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("EtherfuseClient handles malformed non-JSON error responses", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response("502 Bad Gateway from Cloudflare", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as typeof fetch;

  try {
    const client = new EtherfuseClient({
      apiKey: "k",
      baseUrl: "https://api.sand.etherfuse.com",
    });
    const err = await assertRejects(
      () => client.getQuote({ fromCurrency: "USDC", toCurrency: "BRL", fromAmount: "100" }),
      AnchorError,
      "502 Bad Gateway from Cloudflare",
    );
    assertEquals((err as AnchorError).statusCode, 502);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("EtherfuseClient bubbles network timeouts and connection errors", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.reject(new Error("fetch failed: connection timed out"));
  }) as typeof fetch;

  try {
    const client = new EtherfuseClient({
      apiKey: "k",
      baseUrl: "https://api.sand.etherfuse.com",
    });
    await assertRejects(
      () => client.getQuote({ fromCurrency: "USDC", toCurrency: "BRL", fromAmount: "100" }),
      Error,
      "connection timed out",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

// ---- CriptoPix (CnopApi) error, malformed response and timeout coverage -----

Deno.test("CnopApi maps status: false to CnopApiError", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: false,
          message: "Saldo de USDT insuficiente para saque",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const api = new CnopApi({
      clientId: "cid",
      clientSecret: "csecret",
      baseUrl: "https://api.criptonopix.app.br",
    });
    const err = await assertRejects(
      () => api.quote(100, "WITHDRAW"),
      CnopApiError,
      "Saldo de USDT insuficiente para saque",
    );
    assertEquals((err as CnopApiError).statusCode, 200);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("CnopApi handles malformed non-JSON responses gracefully", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response("<html>503 Service Unavailable</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    );
  }) as typeof fetch;

  try {
    const api = new CnopApi({
      clientId: "cid",
      clientSecret: "csecret",
      baseUrl: "https://api.criptonopix.app.br",
    });
    const err = await assertRejects(
      () => api.quote(100),
      CnopApiError,
      "non-json response (503)",
    );
    assertEquals((err as CnopApiError).statusCode, 503);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("CnopApi bubbles network timeouts and connection errors", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.reject(new Error("Network connection reset"));
  }) as typeof fetch;

  try {
    const api = new CnopApi({
      clientId: "cid",
      clientSecret: "csecret",
      baseUrl: "https://api.criptonopix.app.br",
    });
    await assertRejects(
      () => api.quote(100),
      Error,
      "Network connection reset",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

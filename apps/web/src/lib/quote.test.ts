import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

type QuoteModule = typeof import("./quote.ts");

let quote: QuoteModule;

const okFetch = (brlPerUsd: number) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ rates: { BRL: brlPerUsd } }),
  });

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  // Re-import per test so the module-level mid-rate cache never bleeds across cases.
  quote = await import("./quote.ts");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quoteBRLtoUSDC — fee and rate math", () => {
  it("charges no margin when the spread is zero", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const q = await quote.quoteBRLtoUSDC(100, 0);

    expect(q.midRate).toBe(5);
    expect(q.quotedRate).toBe(5);
    expect(q.usdcOut).toBe(20);
    expect(q.usdcAtMid).toBe(20);
    expect(q.marginUsd).toBe(0);
    expect(q.marginBrl).toBe(0);
    expect(q.stale).toBe(false);
  });

  it("applies the canonical platform fee (DEFAULT_PLATFORM_FEE_BP = 297)", async () => {
    vi.stubGlobal("fetch", okFetch(4));

    const q = await quote.quoteBRLtoUSDC(100, DEFAULT_PLATFORM_FEE_BP);

    expect(DEFAULT_PLATFORM_FEE_BP).toBe(297);
    expect(q.spreadBps).toBe(297);
    // 4 BRL/USD × (1 + 0.0297) = 4.1188 BRL/USD the buyer effectively pays.
    expect(q.quotedRate.toFixed(4)).toBe("4.1188");
    // Explicit expected strings — never floating-point equality.
    expect(q.usdcOut.toFixed(7)).toBe("24.2789162");
    expect(q.marginUsd).toBeGreaterThan(0);
  });

  it("uses the module's default spread and pins it (changing it breaks this test)", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    // VITE_FX_SPREAD_BPS default is 190 bps.
    expect(quote.SPREAD_PCT).toBe(1.9);

    const q = await quote.quoteBRLtoUSDC(100);

    expect(q.spreadBps).toBe(190);
    expect(q.usdcOut.toFixed(7)).toBe("19.6270854");
  });

  it("resolves USDC out to the 7-fraction limit without trailing drift", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const q = await quote.quoteBRLtoUSDC(190);

    expect(q.usdcOut.toFixed(7)).toBe("37.2914622");
    // marginBrl is the captured margin expressed at the quoted rate.
    expect(q.marginBrl).toBeCloseTo(q.marginUsd * q.quotedRate, 10);
  });

  it("holds for the smallest and largest accepted amounts", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const small = await quote.quoteBRLtoUSDC(0.01);
    expect(small.usdcOut).toBeGreaterThan(0);
    expect(Number.isFinite(small.usdcOut)).toBe(true);

    const large = await quote.quoteBRLtoUSDC(1_000_000_000);
    expect(Number.isFinite(large.usdcOut)).toBe(true);
    expect(large.usdcOut).toBeGreaterThan(small.usdcOut);
  });
});

describe("quoteBRLtoUSDC — guard rails & spread bounds", () => {
  it("returns zero output for zero and negative input (no throw)", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const zero = await quote.quoteBRLtoUSDC(0);
    expect(zero.usdcOut).toBe(0);
    expect(zero.usdcAtMid).toBe(0);
    expect(zero.marginUsd).toBe(0);

    const negative = await quote.quoteBRLtoUSDC(-100);
    expect(negative.usdcOut).toBe(0);
    expect(negative.usdcAtMid).toBe(0);
  });

  it("treats non-numeric input as zero output", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const nan = await quote.quoteBRLtoUSDC(Number.NaN);
    expect(nan.usdcOut).toBe(0);

    const junk = await quote.quoteBRLtoUSDC("abc" as unknown as number);
    expect(junk.usdcOut).toBe(0);
  });

  it("rejects negative spread bounds with RangeError", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    await expect(quote.quoteBRLtoUSDC(100, -1)).rejects.toThrow(RangeError);
    await expect(quote.quoteBRLtoUSDC(100, -100)).rejects.toThrow("spread_out_of_bounds");
  });

  it("rejects spread exceeding MAX_SPREAD_BPS (10000) with RangeError", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    await expect(quote.quoteBRLtoUSDC(100, 10_001)).rejects.toThrow(RangeError);
    await expect(quote.quoteBRLtoUSDC(100, 50_000)).rejects.toThrow("spread_out_of_bounds");
  });

  it("rejects non-finite spread (NaN, Infinity)", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    await expect(quote.quoteBRLtoUSDC(100, Number.NaN)).rejects.toThrow("spread_out_of_bounds");
    await expect(quote.quoteBRLtoUSDC(100, Number.POSITIVE_INFINITY)).rejects.toThrow("spread_out_of_bounds");
  });
});

describe("midRateBRLperUSD — failure modes & upstream resilience", () => {
  it("falls back and marks stale when upstream returns non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ rates: { BRL: 5.5 } }),
      }),
    );

    const res = await quote.midRateBRLperUSD();
    expect(res.stale).toBe(true);
    expect(res.rate).toBe(quote.FALLBACK_BRL_PER_USD);

    const q = await quote.quoteBRLtoUSDC(54);
    expect(q.stale).toBe(true);
    expect(q.midRate).toBe(5.4);
    expect(q.usdcOut.toFixed(7)).toBe("9.8135427");
  });

  it("falls back and marks stale when body is unparsable non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); },
      }),
    );

    const res = await quote.midRateBRLperUSD();
    expect(res.stale).toBe(true);
    expect(res.rate).toBe(5.4);
  });

  it("falls back and marks stale when response is missing rates.BRL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ rates: {} }),
      }),
    );

    const res = await quote.midRateBRLperUSD();
    expect(res.stale).toBe(true);
    expect(res.rate).toBe(5.4);
  });

  it("falls back and marks stale when upstream rate is zero or negative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ rates: { BRL: -5.0 } }),
      }),
    );

    const neg = await quote.midRateBRLperUSD();
    expect(neg.stale).toBe(true);
    expect(neg.rate).toBe(5.4);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ rates: { BRL: 0 } }),
      }),
    );

    const zero = await quote.midRateBRLperUSD();
    expect(zero.stale).toBe(true);
    expect(zero.rate).toBe(5.4);
  });

  it("falls back and marks stale when request hangs and aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }),
    );

    // Call with short 10ms timeout to trigger abort path quickly
    const res = await quote.midRateBRLperUSD(10);
    expect(res.stale).toBe(true);
    expect(res.rate).toBe(5.4);
  });

  it("cache-hit path asserts stale correctly and never mislabels fallback as fresh", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", failingFetch);

    const first = await quote.midRateBRLperUSD();
    expect(first).toEqual({ rate: 5.4, stale: true });

    // Ensure fallback is never stored in cache as fresh
    const second = await quote.midRateBRLperUSD();
    expect(second).toEqual({ rate: 5.4, stale: true });
    expect(failingFetch).toHaveBeenCalledTimes(2);

    // Now mock recovery
    const recoveryFetch = okFetch(5.5);
    vi.stubGlobal("fetch", recoveryFetch);

    const third = await quote.midRateBRLperUSD();
    expect(third).toEqual({ rate: 5.5, stale: false });

    // Subsequent call within TTL hits cache
    const cached = await quote.midRateBRLperUSD();
    expect(cached).toEqual({ rate: 5.5, stale: false });
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
  });
});

describe("quoteBRLtoUSDC — stale refusal and opt-in protection", () => {
  it("refuses pricing from a stale quote when allowStale is false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    await expect(
      quote.quoteBRLtoUSDC(100, undefined, { allowStale: false }),
    ).rejects.toThrow("stale_quote_refused");
  });

  it("permits pricing from a stale quote when allowStale is explicitly true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const q = await quote.quoteBRLtoUSDC(100, undefined, { allowStale: true });
    expect(q.stale).toBe(true);
    expect(q.midRate).toBe(5.4);
    expect(q.usdcOut).toBeGreaterThan(0);
  });

  it("assertUsableQuote rejects stale quote without explicit opt-in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const staleQuote = await quote.quoteBRLtoUSDC(100);
    expect(staleQuote.stale).toBe(true);

    expect(() => quote.assertUsableQuote(staleQuote)).toThrow("stale_quote_refused");
    expect(() => quote.assertUsableQuote(staleQuote, false)).toThrow("stale_quote_refused");
    expect(() => quote.assertUsableQuote(staleQuote, true)).not.toThrow();
  });

  it("assertUsableQuote accepts fresh quote unconditionally", async () => {
    vi.stubGlobal("fetch", okFetch(5.0));

    const freshQuote = await quote.quoteBRLtoUSDC(100);
    expect(freshQuote.stale).toBe(false);

    expect(quote.assertUsableQuote(freshQuote)).toBe(freshQuote);
    expect(quote.assertUsableQuote(freshQuote, false)).toBe(freshQuote);
  });
});

describe("recordConversionIntent — best-effort margin ledger", () => {
  it("posts the quote fields and never blocks the flow", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    const q = await quote.quoteBRLtoUSDC(100, 297);

    const post = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", post);

    await quote.recordConversionIntent(q, "GABC");

    expect(post).toHaveBeenCalledOnce();
    const body = JSON.parse(post.mock.calls[0]![1].body as string);
    expect(body.spreadBps).toBe(297);
    expect(body.walletId).toBe("GABC");
    expect(body.usdcOut).toBe(q.usdcOut);
  });

  it("swallows transport errors (measurement must never throw)", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    const q = await quote.quoteBRLtoUSDC(10);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

    await expect(quote.recordConversionIntent(q)).resolves.toBeUndefined();
  });
});

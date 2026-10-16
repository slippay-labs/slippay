import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

type QuoteModule = typeof import("./quote.ts");

let quote: QuoteModule;

const okFetch = (brlPerUsd: number) =>
  vi.fn().mockResolvedValue({ json: async () => ({ rates: { BRL: brlPerUsd } }) });

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

describe("quoteBRLtoUSDC — guard rails", () => {
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
});

describe("midRateBRLperUSD — live rate with fallback", () => {
  it("marks the fallback rate stale when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const q = await quote.quoteBRLtoUSDC(54);

    expect(q.stale).toBe(true);
    expect(q.midRate).toBe(5.4);
    expect(q.usdcOut.toFixed(7)).toBe("9.8135427");
  });

  it("falls back when the upstream rate is not a usable positive number", async () => {
    vi.stubGlobal("fetch", okFetch(0));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("caches a good rate for the next 60s", async () => {
    const fetchMock = okFetch(5.25);
    vi.stubGlobal("fetch", fetchMock);

    await quote.midRateBRLperUSD();
    const again = await quote.midRateBRLperUSD();

    expect(again).toEqual({ rate: 5.25, stale: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("midRateBRLperUSD & quoteBRLtoUSDC — in-flight request deduplication (closes #332)", () => {
  it("concurrent callers produce a single upstream request", async () => {
    let resolveNetwork!: (val: any) => void;
    const networkPromise = new Promise((resolve) => {
      resolveNetwork = resolve;
    });

    const fetchSpy = vi.fn().mockImplementation(() =>
      networkPromise.then(() => ({
        json: async () => ({ rates: { BRL: 5.5 } }),
      })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Concurrently trigger 10 calls within the exact same frame/tick
    const calls = Array.from({ length: 10 }, () => quote.midRateBRLperUSD());

    // Assert that immediately, exactly 1 upstream fetch was initiated
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Resolve the in-flight network response
    resolveNetwork(true);

    const results = await Promise.all(calls);
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res).toEqual({ rate: 5.5, stale: false });
    }

    // Still exactly 1 call after all 10 resolved
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("multiple quote consumers mounting simultaneously share one upstream fetch", async () => {
    let resolveNetwork!: (val: any) => void;
    const networkPromise = new Promise((resolve) => {
      resolveNetwork = resolve;
    });

    const fetchSpy = vi.fn().mockImplementation(() =>
      networkPromise.then(() => ({
        json: async () => ({ rates: { BRL: 5.0 } }),
      })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // 3 components quote different BRL amounts on initial mount
    const p1 = quote.quoteBRLtoUSDC(100);
    const p2 = quote.quoteBRLtoUSDC(200);
    const p3 = quote.quoteBRLtoUSDC(500);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveNetwork(true);
    const [q1, q2, q3] = await Promise.all([p1, p2, p3]);

    expect(q1.midRate).toBe(5.0);
    expect(q2.midRate).toBe(5.0);
    expect(q3.midRate).toBe(5.0);

    // Exact expected amounts based on 5.0 mid-rate
    expect(q1.usdcOut).toBeGreaterThan(0);
    expect(q2.usdcOut).toBeCloseTo(q1.usdcOut * 2, 6);
    expect(q3.usdcOut).toBeCloseTo(q1.usdcOut * 5, 6);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a cache miss during an in-flight request does not start a second request", async () => {
    let resolveNetwork!: (val: any) => void;
    const networkPromise = new Promise((resolve) => {
      resolveNetwork = resolve;
    });

    const fetchSpy = vi.fn().mockImplementation(() =>
      networkPromise.then(() => ({
        json: async () => ({ rates: { BRL: 5.2 } }),
      })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // First request starts (cache is cold/empty)
    const call1 = quote.midRateBRLperUSD();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // While call1 is still pending in-flight, a second consumer arrives (cache still cold)
    const call2 = quote.midRateBRLperUSD();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveNetwork(true);
    const [res1, res2] = await Promise.all([call1, call2]);

    expect(res1.rate).toBe(5.2);
    expect(res2.rate).toBe(5.2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("subsequent call after completion uses the resolved 60s cache", async () => {
    const fetchSpy = okFetch(5.3);
    vi.stubGlobal("fetch", fetchSpy);

    const first = await quote.midRateBRLperUSD();
    expect(first.rate).toBe(5.3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Subsequent call within 60s hits resolved cache
    const second = await quote.midRateBRLperUSD();
    expect(second.rate).toBe(5.3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clears in-flight promise upon network failure so future attempts can retry", async () => {
    const errorSpy = vi.fn().mockRejectedValueOnce(new Error("network blip"));
    vi.stubGlobal("fetch", errorSpy);

    // First call fails and falls back to FALLBACK_BRL_PER_USD (stale: true)
    const failResult = await quote.midRateBRLperUSD();
    expect(failResult.stale).toBe(true);
    expect(failResult.rate).toBe(5.4);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // In-flight promise was cleaned up in finally block; new fetch can be attempted
    const successSpy = okFetch(5.1);
    vi.stubGlobal("fetch", successSpy);

    const recovered = await quote.midRateBRLperUSD();
    expect(recovered.stale).toBe(false);
    expect(recovered.rate).toBe(5.1);
    expect(successSpy).toHaveBeenCalledTimes(1);
  });
});

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
  vi.useRealTimers();
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

  it("cache hit reports stale: false and does not issue a second fetch", async () => {
    const fetchMock = okFetch(5.1);
    vi.stubGlobal("fetch", fetchMock);

    const first = await quote.midRateBRLperUSD();
    expect(first).toEqual({ rate: 5.1, stale: false });

    const cached = await quote.midRateBRLperUSD();
    expect(cached).toEqual({ rate: 5.1, stale: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel a fallback as fresh on a subsequent call", async () => {
    // First call fails -> fallback, stale: true. A fallback must not be cached
    // as a good rate, so the next call retries the upstream.
    const fetchMock = vis
      .fn ();
    void fetchMock;
  });

  it("deduplicates concurrent callers into a single upstream request", async () => {
    const fetchMock = okFetch(5.1);
    vi.stubGlobal("fetch", fetchMock);

    const [a, b, c] = await Promise.all([
      quote.midRateBRLperUSD(),
      quote.midRateBRLperUSD(),
      quote.midRateBRLperUSD(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ rate: 5.1, stale: false });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("a cache miss during an in-flight request does not start a second", async () => {
    let resolveJson!: (v: unknown) => void;
    const json = new Promise<unknown>((r) => { resolveJson = r; });
    const fetchMock = vi.fn().mockResolvedValue({ json: () => json });
    vi.stubGlobal("fetch", fetchMock);

    const first = quote.midRateBRLperUSD();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = quote.midRateBRLperUSD();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveJson({ rates: { BRL: 5.5 } });
    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ rate: 5.5, stale: false });
    expect(b).toEqual(a);
  });

  it("shares an in-flight failure with concurrent callers, then retries fresh", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => { throw new Error("bad body"); } })
      .mockResolvedValueOnce({ json: async () => ({ rates: { BRL: 5.25 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([quote.midRateBRLperUSD(), quote.midRateBRLperUSD()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ rate: 5.4, stale: true });
    expect(b).toEqual(a);

    const next = await quote.midRateBRLperUSD();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next).toEqual({ rate: 5.25, stale: false });
  });

  it("several quote consumers mounting together perform one fetch", async () => {
    const fetchMock = okFetch(5);
    vi.stubGlobal("fetch", fetchMock);

    const quotes = await Promise.all([
      quote.quoteBRLtoUSDC(100),
      quote.quoteBRLtoUSDC(250),
      quote.quoteBRLtoUSDC(1_000),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(quotes.map((q) => q.midRate)).toEqual([5, 5, 5]);
    expect(quotes[0]!.usdcOut.toFixed(7)).toBe("19.6270854");
    expect(quotes[1]!.usdcOut.toFixed(7)).toBe("49.0677134");
    expect(quotes[2]!.usdcOut.toFixed(7)).toBe("196.2708538");
  });
});

describe("midRateBRLperUSD — upstream failure modes", () => {
  it("success returns the live rate and is not stale", async () => {
    vi.stubGlobal("fetch", okFetch(5.37));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(false);
    expect(rate).toBe(5.37);
  });

  it("falls back to 5.4 and marks stale on a non-OK HTTP status", async () => {
    const fetchMock = vi.fn().mockResolved({
      ok: false,
      status: 503,
      json: async () => ({ rates: { BRL: 999 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale on an unparsable body", async () => {
    const fetchMock = vis
      .fn ();
    void fetchMock;
  });

  it("falls back and marks stale when the body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolved({
      ok: true,
      headers: { get: () => "text/html" },
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale when rates.BRL is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolved({ ok: true, json: async () => ({ rates: { EUR: 0.92 } }) }));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale on a negative rate", async () => {
    vi.stubGlobal("fetch", okFetch(-3));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale on a zero rate", async () => {
    vi.stubGlobal("fetch", okFetch(0));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale on a non-numeric rate", async () => {
    vi.stubGlobal("fetch", okFetch("not-a-number"));

    const { rate, stale } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(rate).toBe(5.4);
  });

  it("falls back and marks stale when the request hangs (AbortSignal fires)", async () => {
    vi.useFakeTimers();
    // Hanging upstream: the promise never settles on its own. The module must
    // pass an AbortSignal and reject when it fires.
    const fetchMock = vi.fn.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = quote.midRateBRLperUSD();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeIlnstanceOf(AbortSignal);

    // Advance past the module's timeout so the signal fires and the fallback lands.
    await viObject.tickAsync();
    vi.advanceTimersByTime(30_000);
    const result = await Promise.race([pending, Promise.resolve(null)]);
    // If the module does not abort, the result is null and this assertion fails
    // — exactly the hanging-request regression this test pins.
    expect(result).toEqual({ rate: 5.4, stale: true });
  });
});

describe("quoteBRLtoUSDC — stale refusal", () => {
  it("throws when the rate is stale and no opt-in is given", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejected(new Error("offline")));

    await expect(quote.quoteBRLtoUSDC(100)).rejects.toThrow(/stale/i);
  });

  it("prices from a stale rate only with explicit opt-in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejected(new Error("offline")));

    const q = await quote.quoteBRLtoUSDC(100, 190, { allowStale: true });

    expect(q.stale).toBe(true);
    expect(q.midRate).toBe(5.4);
    expect(q.usdcOut).toBeGreaterThan(0);
  });

  it("does not refuse a fresh rate", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const q = await quote.quoteBRLtoUSDC(100);

    expect(q.stale).toBe(false);
    expect(q.usdcOut).toBeGreaterThan(0);
  });
});

describe("spread bounds", () => {
  it("rejects a spread below the lower bound", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    await expect(quote.quoteBRLtoUSDC(100, -1)).rejects.toThrow(/spread/i);
  });

  it("rejects a spread above the upper bound", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    await expect(quote.quoteBRLtoUSDC(100, 10_001)).rejects.toThrow(/spread/i);
  });

  it("rejects a non-numeric spread", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    await expect(quote.quoteBRLtoUSDC(100, Number.NaN)).rejects.toThrow(/spread/i);
  });

  it("accepts the boundary values", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const low = await quote.quoteBRLtoUSDC(100, 0);
    expect(low.spreadBps).toBe(0);

    const high = await quote.quoteBRLtoUSDC(100, 10_000);
    expect(high.spreadBps).toBe(10_000);
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

  it("swallows a non-OK response (never throws)", async () => {
    vi.stubGlobal("fetch", okFetch(5));
    const q = await quote.quoteBRLtoUSDC(10);

    vi.stubGlobal("fetch", vi.fn().mockResolved({ ok: false, status: 500 }));

    await expect(quote.recordConversionIntent(q)).resolves.toBeUndefined();
  });
});
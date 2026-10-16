import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

type QuoteModule = typeof import("./quote.ts");

let quote: QuoteModule;

const okFetch = (brlPerUsd: number) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
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
    expect(q.source).toBe("live");
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

  describe("FX Spread Bounds & Startup Governance (Issue #234)", () => {
    it("uses DEFAULT_FX_SPREAD_BPS (190) from shared constants as single source of truth", () => {
      expect(quote.SPREAD_BPS).toBe(190);
      expect(quote.SPREAD_PCT).toBe(1.9);
    });

    it("fails loudly when VITE_FX_SPREAD_BPS is non-numeric or out-of-range", async () => {
      const { resolveFxSpreadBps } = await import("@slippay/shared");

      expect(() => resolveFxSpreadBps("invalid-string")).toThrow(/must be a valid integer/);
      expect(() => resolveFxSpreadBps("-10")).toThrow(/out of range/);
      expect(() => resolveFxSpreadBps("10001")).toThrow(/out of range/);
    });

    it("logs the active spread configuration once on startup", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.resetModules();
      await import("./quote.ts");
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("[SlipPay FX] Active spread configured: 190 bps"));
    });
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

describe("midRateBRLperUSD — live rate with fallback and HTTP response validation (Issue #235)", () => {
  it("treats non-200 responses (e.g. 500, 404, 429) as failures even if body contains rates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => "application/json" },
        json: async () => ({ rates: { BRL: 9.99 } }),
      })
    );

    const res = await quote.midRateBRLperUSD();
    expect(res.stale).toBe(true);
    expect(res.source).toBe("fallback");
    expect(res.rate).toBe(5.4);
  });

  it("rejects non-JSON response (e.g. HTML error gateway page)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        json: async () => ({ rates: { BRL: 7.77 } }),
      })
    );

    const res = await quote.midRateBRLperUSD();
    expect(res.stale).toBe(true);
    expect(res.source).toBe("fallback");
    expect(res.rate).toBe(5.4);
  });

  it("fails fast on hanging upstream requests without leaving quote pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, opts) => {
        return new Promise((_, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => {
              reject(new Error("aborted by timeout"));
            });
          }
        });
      })
    );

    const res = await quote.midRateBRLperUSD(10);
    expect(res.stale).toBe(true);
    expect(res.source).toBe("fallback");
    expect(res.rate).toBe(5.4);
  });

  it("falls back when the upstream rate is not a usable positive number", async () => {
    vi.stubGlobal("fetch", okFetch(0));

    const { rate, stale, source } = await quote.midRateBRLperUSD();

    expect(stale).toBe(true);
    expect(source).toBe("fallback");
    expect(rate).toBe(5.4);
  });

  it("caches a good rate for the next 60s and tracks source: cache", async () => {
    const fetchMock = okFetch(5.25);
    vi.stubGlobal("fetch", fetchMock);

    const first = await quote.midRateBRLperUSD();
    expect(first).toEqual({ rate: 5.25, stale: false, source: "live" });

    const again = await quote.midRateBRLperUSD();
    expect(again).toEqual({ rate: 5.25, stale: false, source: "cache" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Refusing stale quote fallback without explicit opt-in (Issue #233)", () => {
  it("refuses to quote and throws StaleRateError when upstream is offline unless allowStale is passed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    // Default call without options throws StaleRateError
    await expect(quote.quoteBRLtoUSDC(100)).rejects.toThrow(quote.StaleRateError);
    await expect(quote.quoteBRLtoUSDC(100)).rejects.toThrow(/Live FX rate unavailable/);

    // Call with explicit allowStale: false also throws
    await expect(quote.quoteBRLtoUSDC(100, { allowStale: false })).rejects.toThrow(quote.StaleRateError);
  });

  it("allows obtaining a quote with stale fallback when caller explicitly opts in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    // Explicit opt-in succeeds
    const q = await quote.quoteBRLtoUSDC(54, { allowStale: true });

    expect(q.stale).toBe(true);
    expect(q.source).toBe("fallback");
    expect(q.midRate).toBe(5.4);
    expect(q.usdcOut.toFixed(7)).toBe("9.8135427");
  });

  it("ensures fallback rate cannot produce a price more favourable than last live rate", async () => {
    // 1. Initial live rate succeeds at 5.80 BRL/USD
    const liveFetch = okFetch(5.8);
    vi.stubGlobal("fetch", liveFetch);

    const liveQuote = await quote.quoteBRLtoUSDC(100);
    expect(liveQuote.midRate).toBe(5.8);
    expect(liveQuote.stale).toBe(false);
    expect(liveQuote.source).toBe("live");

    // 2. Next upstream call fails (offline). Default fallback is 5.40.
    // In BRL/USD, 5.40 is MORE favourable to the buyer (cheaper USD -> more USDC out).
    // Conservative rule: Fallback must never be more favourable than the last live rate (5.80).
    quote._resetQuoteCache(); // Clear time cache while keeping lastLiveRate
    // Prime lastLiveRate by calling once
    vi.stubGlobal("fetch", okFetch(5.8));
    await quote.midRateBRLperUSD();

    // Now fail upstream
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gateway down")));
    // Advance time past 60s
    vi.setSystemTime(Date.now() + 61_000);

    const fallbackRes = await quote.midRateBRLperUSD();
    expect(fallbackRes.stale).toBe(true);
    expect(fallbackRes.source).toBe("fallback");
    // Must be at least 5.8, not reverting to 5.4
    expect(fallbackRes.rate).toBe(5.8);
    expect(fallbackRes.rate).toBeGreaterThanOrEqual(5.8);
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

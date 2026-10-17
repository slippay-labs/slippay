import { describe, it, expect, beforeEach } from "vitest";
import {
  getBrlPerUsdc,
  _resetRateCacheForTest,
  _resetRateInFlightForTest,
  RateUnavailableError,
  DEFAULT_FALLBACK_BRL_PER_USDC,
  DEFAULT_RATE_CACHE_TTL_MS,
  type RateResult,
} from "../src/index.ts";

describe("Upstream FX Rate Engine & Resilience", () => {
  beforeEach(() => {
    _resetRateCacheForTest();
    _resetRateInFlightForTest();
  });

  it("successfully fetches live rate from upstream", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ "usd-coin": { brl: 5.65 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      envGetter: () => undefined,
    });

    expect(callCount).toBe(1);
    expect(res).toEqual({
      rate: 5.65,
      stale: false,
      source: "live",
    });
  });

  it("serves subsequent requests within TTL from cache without hitting upstream", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ "usd-coin": { brl: 5.65 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    let currentTime = 1000;
    const nowFn = () => currentTime;

    const res1 = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      nowFn,
      ttlMs: 60_000,
      envGetter: () => undefined,
    });
    expect(res1.source).toBe("live");
    expect(callCount).toBe(1);

    // 10 seconds later: cache hit
    currentTime += 10_000;
    const res2 = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      nowFn,
      ttlMs: 60_000,
      envGetter: () => undefined,
    });
    expect(res2.source).toBe("cache");
    expect(res2.rate).toBe(5.65);
    expect(callCount).toBe(1);
  });

  it("guards against cache stampede: concurrent cold requests trigger exactly one upstream call (Singleflight)", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      // Simulate real upstream roundtrip delay
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ "usd-coin": { brl: 5.72 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Fire 10 concurrent requests simultaneously on cold cache
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        getBrlPerUsdc({
          fetchFn: mockFetch as unknown as typeof fetch,
          envGetter: () => undefined,
        })
      )
    );

    // Exactly one upstream network call occurred
    expect(callCount).toBe(1);
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.rate).toBe(5.72);
      expect(r.stale).toBe(false);
      expect(r.source).toBe("live");
    }
  });

  it("produces bounded-latency response and avoids platform timeout when upstream hangs", async () => {
    let aborted = false;
    const mockFetch = async (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }
      });
    };

    const startTime = Date.now();
    const res = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 40,
      maxRetries: 1,
      backoffMs: 10,
      fallbackRate: 5.4,
      allowFallback: true,
      envGetter: () => undefined,
    });
    const elapsed = Date.now() - startTime;

    expect(aborted).toBe(true);
    expect(res.rate).toBe(5.4);
    expect(res.stale).toBe(true);
    expect(res.source).toBe("fallback");
    // Assert response completed promptly without hanging
    expect(elapsed).toBeLessThan(1000);
  });

  it("recovers gracefully from transient upstream failures via exponential backoff retries", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        // Transient 500 Bad Gateway on first attempt
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ "usd-coin": { brl: 5.80 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      maxRetries: 2,
      backoffMs: 10,
      envGetter: () => undefined,
    });

    expect(callCount).toBe(2);
    expect(res.rate).toBe(5.80);
    expect(res.stale).toBe(false);
    expect(res.source).toBe("live");
  });

  it("falls back to documented safe rate when all retries fail and fallback is enabled", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("Rate limit exceeded", { status: 429 });
    };

    const res = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      maxRetries: 2,
      backoffMs: 10,
      fallbackRate: DEFAULT_FALLBACK_BRL_PER_USDC,
      allowFallback: true,
      envGetter: () => undefined,
    });

    expect(callCount).toBe(3); // Initial + 2 retries
    expect(res.rate).toBe(DEFAULT_FALLBACK_BRL_PER_USDC);
    expect(res.stale).toBe(true);
    expect(res.source).toBe("fallback");
  });

  it("throws typed RateUnavailableError (503) when fallback is explicitly disabled", async () => {
    const mockFetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    await expect(
      getBrlPerUsdc({
        fetchFn: mockFetch as unknown as typeof fetch,
        maxRetries: 1,
        backoffMs: 10,
        allowFallback: false,
        envGetter: () => undefined,
      })
    ).rejects.toThrow(RateUnavailableError);

    try {
      await getBrlPerUsdc({
        fetchFn: mockFetch as unknown as typeof fetch,
        maxRetries: 0,
        allowFallback: false,
        envGetter: () => undefined,
      });
    } catch (err: unknown) {
      const e = err as RateUnavailableError;
      expect(e.status).toBe(503);
      expect(e.code).toBe("rate_unavailable");
    }
  });

  it("respects RATE_BRL_USDC fixed env override in test/staging environments", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("Should not be called", { status: 500 });
    };

    const res = await getBrlPerUsdc({
      fetchFn: mockFetch as unknown as typeof fetch,
      envGetter: (k) => (k === "RATE_BRL_USDC" ? "6.25" : undefined),
    });

    expect(callCount).toBe(0);
    expect(res).toEqual({
      rate: 6.25,
      stale: false,
      source: "env",
    });
  });
});

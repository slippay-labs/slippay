import { describe, it, expect, beforeEach } from "vitest";
import {
  SharedMemoryRateLimitStore,
  TwoTierRateLimiter,
  type RateLimitStore,
} from "../src/rate_limiter.ts";

describe("Durable Cross-Isolate Rate Limiting (Issue #191)", () => {
  let sharedStore: SharedMemoryRateLimitStore;

  beforeEach(() => {
    sharedStore = new SharedMemoryRateLimitStore();
  });

  it("ensures two concurrent processes sharing the store cannot exceed configured capacity", async () => {
    const capacity = 5;
    const refillPerSec = 0.01; // Slow refill

    // Isolate A & Isolate B have separate in-memory caches, but share the persistent authority
    const isolateA = new TwoTierRateLimiter({
      capacity,
      refillPerSec,
      store: sharedStore,
    });
    const isolateB = new TwoTierRateLimiter({
      capacity,
      refillPerSec,
      store: sharedStore,
    });

    const targetKey = "ip:198.51.100.42";

    // Simultaneously fire 5 requests from isolate A and 5 requests from isolate B (10 total)
    const requests = [
      ...Array.from({ length: 5 }).map(() => isolateA.consume(targetKey)),
      ...Array.from({ length: 5 }).map(() => isolateB.consume(targetKey)),
    ];

    const results = await Promise.all(requests);
    const allowedCount = results.filter((r) => r.allowed).length;
    const rejectedCount = results.filter((r) => !r.allowed).length;

    // Strict invariant: exactly 5 succeed, exactly 5 are rejected with 429
    expect(allowedCount).toBe(capacity);
    expect(rejectedCount).toBe(5);

    for (const rejected of results.filter((r) => !r.allowed)) {
      expect(rejected.status).toBe(429);
      expect(rejected.reason).toBe("rate_limited");
      expect(rejected.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it("ensures a restarted process (cold start) does not grant a fresh budget", async () => {
    const capacity = 3;
    const refillPerSec = 0.01;
    const targetKey = "merchant:merc_9999";

    // Instance 1 consumes entire budget
    const instance1 = new TwoTierRateLimiter({
      capacity,
      refillPerSec,
      store: sharedStore,
    });

    for (let i = 0; i < capacity; i++) {
      const res = await instance1.consume(targetKey);
      expect(res.allowed).toBe(true);
    }

    const exhaustedRes = await instance1.consume(targetKey);
    expect(exhaustedRes.allowed).toBe(false);
    expect(exhaustedRes.status).toBe(429);

    // Simulate process crash & cold start: instance 2 is initialized with empty local memory
    const coldInstance2 = new TwoTierRateLimiter({
      capacity,
      refillPerSec,
      store: sharedStore,
    });

    // Cold start attempt MUST NOT receive a fresh budget
    const coldRes = await coldInstance2.consume(targetKey);
    expect(coldRes.allowed).toBe(false);
    expect(coldRes.status).toBe(429);
    expect(coldRes.reason).toBe("rate_limited");
  });

  it("strictly enforces /v1/ask daily cap across multiple distributed isolates", async () => {
    const dailyCap = 20; // Simulated daily limit
    const refillPerSec = dailyCap / 86400; // Refill over 24h
    const targetKey = "ask_per_day:ip:203.0.113.10";

    // Simulate 4 distinct isolates in a cluster
    const isolates = Array.from({ length: 4 }).map(
      () =>
        new TwoTierRateLimiter({
          capacity: dailyCap,
          refillPerSec,
          store: sharedStore,
        })
    );

    let allowedTotal = 0;

    // Round-robin 25 requests across the 4 isolates
    for (let i = 0; i < 25; i++) {
      const currentIsolate = isolates[i % isolates.length];
      const res = await currentIsolate.consume(targetKey);
      if (res.allowed) {
        allowedTotal++;
      }
    }

    // Exactly 20 allowed, remaining 5 rejected across isolates
    expect(allowedTotal).toBe(dailyCap);

    // Any isolate now rejects immediately
    for (const isolate of isolates) {
      const check = await isolate.consume(targetKey);
      expect(check.allowed).toBe(false);
      expect(check.status).toBe(429);
    }
  });

  it("fails closed on sensitive scopes when the shared store is unreachable", async () => {
    const brokenStore: RateLimitStore = {
      consume: async () => {
        throw new Error("Connection to database timed out");
      },
    };

    const sensitiveLimiter = new TwoTierRateLimiter({
      capacity: 10,
      refillPerSec: 1,
      store: brokenStore,
      failClosed: true,
    });

    const res = await sensitiveLimiter.consume("ask_sensitive:user_123");
    expect(res.allowed).toBe(false);
    expect(res.status).toBe(429);
    expect(res.retryAfterSec).toBe(5);
  });
});

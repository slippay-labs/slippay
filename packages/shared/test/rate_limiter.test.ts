import { describe, it, expect, beforeEach } from "vitest";
import { TokenBucketRateLimiter } from "../src/rate_limiter.ts";

describe("TokenBucketRateLimiter with Admission Control (Issue #192)", () => {
  it("admits requests up to capacity and refills tokens over time", () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSec: 1,
      maxBuckets: 10,
    });

    const now = 10000;
    // 3 consumed
    expect(limiter.consume("user_1", now).allowed).toBe(true);
    expect(limiter.consume("user_1", now).allowed).toBe(true);
    expect(limiter.consume("user_1", now).allowed).toBe(true);

    // 4th consumed -> 429 rate_limited
    const res = limiter.consume("user_1", now);
    expect(res.allowed).toBe(false);
    expect(res.status).toBe(429);
    expect(res.reason).toBe("rate_limited");
    expect(res.retryAfterSec).toBe(1);

    // 1 second later -> 1 token refilled -> allowed
    expect(limiter.consume("user_1", now + 1000).allowed).toBe(true);
  });

  it("enforces admission control and rejects new keys when maxBuckets is reached (Issue #192)", () => {
    const maxBuckets = 5;
    const limiter = new TokenBucketRateLimiter({
      capacity: 10,
      refillPerSec: 1,
      maxBuckets,
    });

    // Fill table with 5 distinct keys
    for (let i = 0; i < maxBuckets; i++) {
      const res = limiter.consume(`client_${i}`);
      expect(res.allowed).toBe(true);
      expect(res.status).toBe(200);
    }
    expect(limiter.getBucketCount()).toBe(maxBuckets);

    // Any new key beyond capacity is rejected with 429 capacity_exceeded
    for (let i = maxBuckets; i < maxBuckets + 10; i++) {
      const res = limiter.consume(`client_${i}`);
      expect(res.allowed).toBe(false);
      expect(res.status).toBe(429);
      expect(res.reason).toBe("capacity_exceeded");
      expect(res.retryAfterSec).toBe(1);
    }

    // Capacity rejections metric accurately counts all 10 rejected keys
    expect(limiter.getCapacityRejectionsTotal()).toBe(10);

    // The table size has NOT grown and original buckets have NOT been evicted
    expect(limiter.getBucketCount()).toBe(maxBuckets);
    for (let i = 0; i < maxBuckets; i++) {
      expect(limiter.hasBucket(`client_${i}`)).toBe(true);
    }
  });

  it("proves flooding with new keys cannot evict an existing key or restore its spent budget (Issue #192)", () => {
    const maxBuckets = 5;
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSec: 0.001, // extremely slow refill
      maxBuckets,
    });

    const now = 100000;

    // Victim client spends their entire budget
    expect(limiter.consume("victim_client", now).allowed).toBe(true);
    expect(limiter.consume("victim_client", now).allowed).toBe(true);
    const exhausted = limiter.consume("victim_client", now);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reason).toBe("rate_limited");

    // Add 4 other legitimate clients to reach maxBuckets (5)
    for (let i = 0; i < 4; i++) {
      expect(limiter.consume(`other_${i}`, now).allowed).toBe(true);
    }
    expect(limiter.getBucketCount()).toBe(maxBuckets);

    // Attacker floods with 100 new spoofed keys attempting to evict victim_client
    for (let i = 0; i < 100; i++) {
      const floodRes = limiter.consume(`attacker_spoof_${i}`, now);
      expect(floodRes.allowed).toBe(false);
      expect(floodRes.reason).toBe("capacity_exceeded");
    }

    // Invariant check: victim_client's bucket was NOT evicted
    expect(limiter.hasBucket("victim_client")).toBe(true);

    // Crucial check: victim_client still has zero tokens and is STILL rate limited!
    const recheck = limiter.consume("victim_client", now);
    expect(recheck.allowed).toBe(false);
    expect(recheck.reason).toBe("rate_limited"); // Not reset to fresh tokens!
  });

  it("sweep removes inactive buckets past TTL and restores admission capacity", () => {
    const maxBuckets = 3;
    const ttlMs = 60_000;
    const limiter = new TokenBucketRateLimiter({
      capacity: 5,
      refillPerSec: 1,
      maxBuckets,
      bucketTtlMs: ttlMs,
    });

    const t0 = 10000;
    limiter.consume("idle_1", t0);
    limiter.consume("idle_2", t0);
    limiter.consume("active_3", t0);
    expect(limiter.getBucketCount()).toBe(3);

    // Table is full; new client is rejected
    expect(limiter.consume("new_client", t0).reason).toBe("capacity_exceeded");

    // Advance time past TTL for idle_1 and idle_2, but keep active_3 active
    const t1 = t0 + ttlMs + 5000;
    limiter.consume("active_3", t1); // updates active_3 lastRefill

    // Sweep inactive buckets
    const swept = limiter.sweep(ttlMs, t1);
    expect(swept).toBe(2);
    expect(limiter.getBucketCount()).toBe(1);
    expect(limiter.hasBucket("active_3")).toBe(true);
    expect(limiter.hasBucket("idle_1")).toBe(false);
    expect(limiter.hasBucket("idle_2")).toBe(false);

    // Now new client can be successfully admitted!
    const admitted = limiter.consume("new_client", t1);
    expect(admitted.allowed).toBe(true);
    expect(limiter.getBucketCount()).toBe(2);
  });
});

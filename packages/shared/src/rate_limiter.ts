/**
 * Token Bucket Rate Limiter with Admission Control — Issue #192
 *
 * Prevents memory exhaustion attacks without resetting attacker's spent budget.
 *
 * Security Model & Invariants:
 * 1. Admission Control: When the tracked bucket map reaches `maxBuckets`, new keys
 *    are rejected with 429 (`capacity_exceeded`) rather than evicting existing buckets.
 * 2. Budget Integrity: Flooding with attacker-generated keys CANNOT evict an existing
 *    key or restore its consumed budget.
 * 3. TTL Expiry: Inactive keys are only evicted via sweep when their idle time exceeds TTL.
 * 4. Capacity Metrics: Tracks `capacityRejectionsTotal` to monitor flood pressure and alert.
 */

export interface Bucket {
  tokens: number;
  lastRefill: number; // ms epoch
}

export interface LimiterOptions {
  capacity: number;
  refillPerSec: number;
  maxBuckets?: number;
  bucketTtlMs?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  status: 200 | 429;
  reason?: "capacity_exceeded" | "rate_limited";
  retryAfterSec?: number;
  remainingTokens?: number;
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxBuckets: number;
  private readonly bucketTtlMs: number;
  private readonly buckets: Map<string, Bucket> = new Map();
  private capacityRejectionsTotal = 0;

  constructor(options: LimiterOptions) {
    if (options.capacity <= 0 || !Number.isFinite(options.capacity)) {
      throw new Error("capacity must be a positive finite number");
    }
    if (options.refillPerSec <= 0 || !Number.isFinite(options.refillPerSec)) {
      throw new Error("refillPerSec must be a positive finite number");
    }
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
    this.maxBuckets = options.maxBuckets ?? 10_000;
    this.bucketTtlMs = options.bucketTtlMs ?? 5 * 60_000;
  }

  public consume(key: string, now: number = Date.now()): ConsumeResult {
    let bucket = this.buckets.get(key);

    if (bucket) {
      // Existing tracked bucket
      const elapsedSec = Math.max(0, (now - bucket.lastRefill) / 1000);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.lastRefill = now;
    } else {
      // New key admission control: reject at capacity rather than evicting tracked buckets
      if (this.buckets.size >= this.maxBuckets) {
        this.capacityRejectionsTotal++;
        return {
          allowed: false,
          status: 429,
          reason: "capacity_exceeded",
          retryAfterSec: 1,
        };
      }

      bucket = { tokens: this.capacity, lastRefill: now };
    }

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSec));
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        status: 429,
        reason: "rate_limited",
        retryAfterSec,
        remainingTokens: bucket.tokens,
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      status: 200,
      remainingTokens: bucket.tokens,
    };
  }

  public sweep(ttlMs: number = this.bucketTtlMs, now: number = Date.now()): number {
    let swept = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.lastRefill > ttlMs) {
        this.buckets.delete(k);
        swept++;
      }
    }
    return swept;
  }

  public getCapacityRejectionsTotal(): number {
    return this.capacityRejectionsTotal;
  }

  public getBucketCount(): number {
    return this.buckets.size;
  }

  public hasBucket(key: string): boolean {
    return this.buckets.has(key);
  }

  public getBucket(key: string): Bucket | undefined {
    return this.buckets.get(key);
  }

  public reset(): void {
    this.buckets.clear();
    this.capacityRejectionsTotal = 0;
  }
}

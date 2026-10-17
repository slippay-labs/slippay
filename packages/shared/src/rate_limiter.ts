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

/**
 * Shared storage interface for cross-isolate rate limiting — Issue #191
 */
export interface RateLimitStore {
  consume(
    id: string,
    capacity: number,
    refillPerSec: number,
    nowMs?: number
  ): Promise<ConsumeResult>;
}

/**
 * In-memory atomic shared store simulating multi-isolate access.
 * Uses mutex queue to guarantee atomic check-and-decrement.
 */
export class SharedMemoryRateLimitStore implements RateLimitStore {
  private readonly state: Map<string, { tokens: number; lastRefillMs: number }> = new Map();
  private readonly queue: Map<string, Promise<void>> = new Map();

  public async consume(
    id: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number = Date.now()
  ): Promise<ConsumeResult> {
    // Acquire per-key lock to serialize atomic updates like postgres row-level lock
    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const currentLock = this.queue.get(id) ?? Promise.resolve();
    this.queue.set(id, currentLock.then(() => lockPromise));

    await currentLock;
    try {
      let bucket = this.state.get(id);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefillMs: nowMs };
      } else {
        const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
        bucket.lastRefillMs = nowMs;
      }

      if (bucket.tokens < 1.0) {
        const retryAfterSec = Math.max(1, Math.ceil((1.0 - bucket.tokens) / refillPerSec));
        this.state.set(id, bucket);
        return {
          allowed: false,
          status: 429,
          reason: "rate_limited",
          retryAfterSec,
          remainingTokens: bucket.tokens,
        };
      }

      bucket.tokens -= 1.0;
      this.state.set(id, bucket);
      return {
        allowed: true,
        status: 200,
        remainingTokens: bucket.tokens,
      };
    } finally {
      releaseLock();
    }
  }

  public reset(): void {
    this.state.clear();
    this.queue.clear();
  }
}

/**
 * Supabase Postgres RPC-backed durable rate limit store
 */
export class SupabaseRateLimitStore implements RateLimitStore {
  constructor(private readonly supabaseClient: any) {}

  public async consume(
    id: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number = Date.now()
  ): Promise<ConsumeResult> {
    const { data, error } = await this.supabaseClient.rpc("consume_rate_limit_token", {
      p_id: id,
      p_capacity: capacity,
      p_refill_per_sec: refillPerSec,
      p_now_ms: nowMs,
    });

    if (error || !data || data.length === 0) {
      throw new Error(`Database rate limit check failed: ${error?.message ?? "empty response"}`);
    }

    const row = data[0];
    if (!row.allowed) {
      return {
        allowed: false,
        status: 429,
        reason: "rate_limited",
        retryAfterSec: row.retry_after_sec ?? 1,
        remainingTokens: Number(row.tokens_remaining ?? 0),
      };
    }

    return {
      allowed: true,
      status: 200,
      remainingTokens: Number(row.tokens_remaining ?? 0),
    };
  }
}

export interface TwoTierLimiterOptions extends LimiterOptions {
  store?: RateLimitStore;
  failClosed?: boolean;
}

/**
 * Two-tier limiter: fast local in-memory pre-check + durable shared authority.
 * Fails closed on sensitive endpoints if store is down.
 */
export class TwoTierRateLimiter {
  private readonly localLimiter: TokenBucketRateLimiter;
  private readonly store?: RateLimitStore;
  private readonly failClosed: boolean;
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(options: TwoTierLimiterOptions) {
    this.localLimiter = new TokenBucketRateLimiter(options);
    this.store = options.store;
    this.failClosed = options.failClosed ?? false;
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
  }

  public async consume(key: string, now: number = Date.now()): Promise<ConsumeResult> {
    // Tier 1: Local memory fast pre-check (avoids remote trip if local limit is already exceeded)
    const localRes = this.localLimiter.consume(key, now);
    if (!localRes.allowed) {
      return localRes;
    }

    // Tier 2: Authoritative shared store across isolates
    if (!this.store) {
      return localRes;
    }

    try {
      const storeRes = await this.store.consume(key, this.capacity, this.refillPerSec, now);
      if (!storeRes.allowed) {
        // Synchronize local limiter to exhausted state
        const localBucket = this.localLimiter.getBucket(key);
        if (localBucket) {
          localBucket.tokens = 0;
        }
      }
      return storeRes;
    } catch (err: unknown) {
      if (this.failClosed) {
        return {
          allowed: false,
          status: 429,
          reason: "rate_limited",
          retryAfterSec: 5,
        };
      }
      // Fail-open for non-sensitive scopes if configured
      return localRes;
    }
  }

  public resetLocal(): void {
    this.localLimiter.reset();
  }
}


// Audit-004 · C6 — token-bucket rate limiter applied to every API route.
//
// Keyed by client identity: for authenticated routes, by `merchant.id`; for
// unauthenticated routes, by the trusted connection IP (see lib/client_ip.ts).
//
// Durability: the authoritative bucket state lives in the `rate_limit_buckets`
// Postgres table (see migration 20260508120000_rate_limit_buckets.sql) and is
// refilled/decremented atomically via the `rate_limit_consume()` function. This
// makes the limits hold across isolates and across cold starts. The in-memory
// map below is kept as a fast local pre-check only; it can reject early but
// never grants a request the shared store would deny.
//
// Defaults:
//  - 60 requests/min per key for general API routes (orders, subscriptions,
//    merchants)
//  - 5 requests/min and 100 requests/day per IP for /v1/ask (audit-004 C7).
//    Enforced via a stricter limiter applied locally in the ask route.
//
// Window: a classic token-bucket of `capacity` tokens that refill at
// `refillPerSec` tokens/second. Exhausted callers get 429 with a
// `retry-after` header.

import type { Context, Next } from "hono";
import { clientIp, type ConnInfo } from "../lib/client_ip.ts";
import { getSupabaseAdmin } from "../lib/supabase.ts";

export interface Bucket {
  tokens: number;
  lastRefill: number; // mms epoch
}

export interface LimiterConfig {
  capacity: number;
  refillPerSec: number;
  /** How to derive the key. Default: trusted connection IP || "anon". */
  key?: (c: Context) => string;
  /** Identifier for diagnostic 429 body. */
  scope?: string;
  /** Maximum number of buckets tracked before LRU eviction. Defaults to 10,000. */
  maxBuckets?: number;
  /**
   * When true, fail closed if the shared store is unreachable. Use this
   * for sensitive scopes (e.g. /v1/ask) where the limiter is the only
   * control. Defaults to false (fail open).
   */
  failClosed?: boolean;
}

export const DEFAULT_MAX_BUCKETS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
const BUCKET_TTL_MS = 5 * 60_000;

// Module-level LRU map preserving insertion/access order. This is a
// local pre-check only; the shared store is the authority.
const buckets: Map<string, Bucket> = new Map();
let lastSweep = Date.now();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function sweepBuckets(ttlMs = BUCKET_TTL_MS) {
  const now = Date.now();
  lastSweep = now;
  for (const [i, b] of buckets) {
    if (now - b.lastRefill > ttlMs) {
      buckets.delete(i);
    }
  }
}

export function ensureSweepTimer() {
  if (sweepTimer === null && typeof setInterval !== "undefined") {
    sweepTimer = setInterval(() => sweepBuckets(), SWEEP_INTERVAL_MS);
    try {
      if (typeof (sweepTimer as any)?.unref === "function") {
        (sweepTimer as any).unref();
      } else if (typeof (globalThis as any).Deno?.unrefTimer === "function") {
        (globalThis as any).Deno.unrefTimer(sweepTimer);
      }
    } catch {
      // ignore
    }
  }
}

function sweepIfDue() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  sweepBuckets();
}

// Audit-005 · H1 — derive the bucket key from the trusted connection IP, NOT the
// client-forgeable left-most X-Forwarded-For hop. See lib/client_ip.ts.
// On Deno, Hono exposes the connection info (with remoteAddr) as `c.env`.
function defaultKey(c: Context): string {
  return clientIp(c.req, c.env as ConnInfo | undefined);
}

export interface ConsumeResult {
  allowed: boolean;
  tokensLeft: number;
}

/**
 * Atomically refill and consume one token from the shared store.
 * Throws if the store is unreachable; callers decide fail-open vs. fail-closed.
 */
export async function consumeShared(
  id: string,
  capacity: number,
  refillPerSec: number,
): Promise<ConsumeResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("rate_limit_consume", {
    p_id: id,
    p_capacity: capacity,
    p_refill_per_sec: refillPerSec,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("rate_limit_consume returned no rows");
  return {
    allowed: Boolean(row.allowed),
    tokensLeft: Number(row.tokens_left ?? 0),
  };
}

export function rateLimit(cfg: LimiterConfig) {
  const { capacity, refillPerSec } = cfg;
  const keyFn = cfg.key ?? defaultKey;
  const scope = cfg.scope ?? "default";
  const failClosed = cfg.failClosed ?? false;

  return async (c: Context, next: Next) => {
    ensureSweepTimer();
    sweepIfDue();

    const maxBuckets = cfg.maxBuckets ?? (
      typeof Deno !== "undefined" && Deno.env?.get("RATE_LIMIT_MAX_BUCKETS")
        ? parseInt(Deno.env.get("RATE_LIMIT_MAX_BUCKETS")!)  || DEFAULT_MAX_BUCKETS
        : DEFAULT_MAX_BUCKETS
    );

    const id = `${scope}:${keyFn(c)}`;
    const now = Date.now();

    // --- Local pre-check ---
    // The local map is only allowed to reject early. It never grants a
    // request that the shared store would deny, so it cannot by itself
    // inflate the budget.
    let bucket = buckets.get(id);
    if (bucket) {
      // Re-insert to refresh position to most-recently used (MRU)
      buckets.delete(id);
    } else {
      // If at capacity, evict the least recently used (first in Map)
      if (buckets.size >= maxBuckets) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey && oldestKey !== id) {
          buckets.delete(oldestKey);
        }
      }

      // If still at capacity (e.g. maxBuckets === 0), fail closed with 429
      if (buckets.size >= maxBuckets) {
        return c.json(
          { error: "rate_limited", scope, reason: "capacity_exceeded", retry_after_sec: 1 },
          429,
          { "retry-after": "1" },
        );
      }

      bucket = { tokens: capacity, lastRefill: now };
    }

    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retrySec = Math.ceil((1 - bucket.tokens) / refillPerSec);
      buckets.set(id, bucket);
      return c.json(
        { error: "rate_limited", scope, retry_after_sec: retrySec },
        429,
        { "retry-after": String(retrySec) },
      );
    }

    // --- Shared store authority ---
    // Atomic refill + decrement in Postgres. Concurrent isolates cannot
    // double-spend a token because the refill and decrement happen in
    // a single UPDATE statement.
    let result: ConsumeResult;
    try {
      result = await consumeShared(id, capacity, refillPerSec);
    } catch (err) {
      console.error("rate_limit shared store unreachable", { scope, err });
      if (failClosed) {
        // Sensitive scope: treat an unreachable store as exhausted.
        buckets.set(id, { tokens: 0, lastRefill: now });
        return c.json(
          { error: "rate_limited", scope, reason: "store_unavailable", retry_after_sec: 1 },
          429,
          { "retry-after": "1" },
        );
      }
      // Non-sensitive scope: fall back to the local bucket so the
      // request still gets a reasonable per-isolate limit.
      bucket.tokens -= 1;
      buckets.set(id, bucket);
      await next();
      return;
    }

    if (!result.allowed) {
      // Store denied: mirror the decision locally so the pre-check also
      // rejects follow-up requests on this isolate without hitting the
      // database again.
      buckets.set(id, { tokens: 0, lastRefill: now });
      const retrySec = Math.max(1, Math.ceil(1 / refillPerSec));
      return c.json(
        { error: "rate_limited", scope, retry_after_sec: retrySec },
        429,
        { "retry-after": String(retrySec) },
      );
    }

    // Record the shared store's view of remaining tokens locally.
    buckets.set(id, { tokens: result.tokensLeft, lastRefill: now });
    await next();
  };
}

// Atomic daily cap for /v1/ask. Uses the same shared store with a
// capacity of `dailyCapacity` and a refill rate of one token per day, so
// the bucket is full at the start of each 24h-hour window and drains as
// requests are consumed. Keyed per IP and per day so a restart or a different
// isolate cannot grant a fresh budget.
export function dailyCap(cfg: LimiterConfig & { dailyCapacity: number }) {
  const keyFn = cfg.key ?? defaultKey;
  const scope = cfg.scope ?? "daily";
  const failClosed = cfg.failClosed ?? true;
  const dailyCapacity = cfg.dailyCapacity;
  // One token per day = 1 / 86400 tokens/second.
  const refillPerSec = 1 / 86400;

  return async (c: Context, next: Next) => {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const id = `${scope}:${day}:${keyFn(c)}`;

    let result: ConsumeResult;
    try {
      result = await consumeShared(id, dailyCapacity, refillPerSec);
    } catch (err) {
      console.error("rate_limit daily store unreachable", { scope, err });
      if (failClosed) {
        return c.json(
          { error: "rate_limited", scope, reason: "store_unavailable", retry_after_sec: 60 },
          429,
          { "retry-after": "60" },
        );
      }
      await next();
      return;
    }

    if (!result.allowed) {
      // Retry after the next day boundary at the earliest.
      const now = new Date();
      const nextDay = new Date(now);
      nextDay.setUTCHours(24, 0, 0, 0);
      const retrySec = Math.max(1, Math.ceil((nextDay.getTime() - now.getTime()) / 1000));
      return c.json(
        { error: "rate_limited", scope, retry_after_sec: retrySec },
        429,
        { "retry-after": String(retrySec) },
      );
    }

    await next();
  };
}

/** Derive a key bound to the authenticated merchant.id; falls back to IP. */
export function merchantKey(c: Context): string {
  const m = c.get("merchant") as { id?: string } | undefined;
  return m?.id ?? defaultKey(c);
}

/** Visible for tests. */
export function __resetBuckets() {
  buckets.clear();
  lastSweep = Date.now();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function __getBucketCount(): number {
  return buckets.size;
}

export function __hasBucket(id: string): boolean {
  return buckets.has(id);
}

export function __getBucket(id: string): Bucket | undefined {
  return buckets.get(id);
}
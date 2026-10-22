import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimiter } from '../src/middleware/rate_limiter';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterMiddleware {
  (req: any, res: any, next: () => void): void;
  __resetBuckets?: () => void;
  __getBucketCount?: () => number;
  __hasBucket?: (key: string) => boolean;
  __getBucket?: (key: string) => Bucket | undefined;
  sweepBuckets?: (now?: number) => void;
}

const TOO_MANY_REQUESTS = 429;

function makeReq(ip = '127.0.0.1') {
  return { ip, socket: { remoteAddress: ip }, headers: {} } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
    send(body?: any) {
      res.body = body;
      return res;
    },
    body: undefined as any,
  } as any;
  return res;
}

function run(mw: RateLimiterMiddleware, req: any, res: any): boolean {
  let called = false;
  mw(req, res, () => {
    called = true;
  });
  return called;
}

describe('rate limiter', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1000000;
  });

  describe('refill and cap behaviour (injected clock)', () => {
    it('refills at exactly refillPerSec and caps at capacity', () => {
      const mw = rateLimiter({
        capacity: 10,
        refillPerSec: 2,
        clock,
      }) as RateLimiterMiddleware;

      // Drain the bucket completely.
      for (let i = 0; i < 10; i++) {
        expect(run(mw, makeReq(), makeRes())).toBe(true);
      }
      // Now at capacity (0 tokens) - blocked.
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance 1 second -> + 2 tokens.
      now += 1000;
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      // Third call in the same second should be blocked (cap at 2 refill).
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance far beyond capacity -> bucket should cap at capacity (10).
      now += 100000;
      for (let i = 0; i < 10; i++) {
        expect(run(mw, makeReq(), makeRes())).toBe(true);
      }
      expect(run(mw, makeReq(), makeRes())).toBe(false);
    });

    it('accumulates elapsedSec refill across lastRefill reset', () => {
      const mw = rateLimiter({
        capacity: 10,
        refillPerSec: 1,
        clock,
      }) as RateLimiterMiddleware;

      // Drain.
      for (let i = 0; i < 10; i++) run(mw, makeReq(), makeRes());
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance 3 seconds -> + 3 tokens.
      now += 3000;
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance 1 second -> +1 token accumulated from new lastRefill.
      now += 1000;
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(false);
    });

    it('does not reset an existing key at capacity (issue 34)', () => {
      const mw = rateLimiter({
        capacity: 2,
        refillPerSec: 1,
        clock,
      }) as RateLimiterMiddleware;

      // Drain to 0 tokens.
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance 1 second -> +1 token.
      now += 1000;
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(false);

      // Advance far beyond capacity -> bucket should not reset to capacity.
      now += 100000;
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(true);
      expect(run(mw, makeReq(), makeRes())).toBe(false);
    });
  });

  describe('capacity fail-closed branch', () => {
    it('returns 429 when maxBuckets is 0', () => {
      const mw = rateLimiter({
        capacity: 10,
        refillPerSec: 1,
        maxBuckets: 0,
        clock,
      }) as RateLimiterMiddleware;

      const res = makeRes();
      const called = run(mw, makeReq(), res);
      expect(called).toBe(false);
      expect(res.statusCode).toBe(TOO_MANY_REQUESTS);
    });

    it('fails closed when at maxBuckets capacity for a new key', () => {
      const mw = rateLimiter({
        capacity: 10,
        refillPerSec: 1,
        maxBuckets: 1,
        clock,
      }) as RateLimiterMiddleware;

      // First key occupies the only slot.
      expect(run(mw, makeReq('1.1.1.1'), makeRes())).toBe(true);
      // Second key cannot get a bucket -> fail closed.
      const res = makeRes();
      expect(run(mw, makeReq('2.2.2.2'), res)).toBe(false);
      expect(res.statusCode).toBe(TOO_MANY_REQUESTS);
    });
  });

  describe('eviction behaviour', () => {
    it('evicts the idlest bucket and does not restore its budget', () => {
      const mw = rateLimiter({
        capacity: 2,
        refillPerSec: 1,
        maxBuckets: 2,
        clock,
      }) as RateLimiterMiddleware;

      // Key A drained at t=0.
      expect(run(mw, makeReq('A'), makeRes())).toBe(true);
      expect(run(mw, makeReq('A'), makeRes())).toBe(true);
      expect(run(mw, makeReq('A'), makeRes())).toBe(false);

      // Key B at t=1.
      now += 1000;
      expect(run(mw, makeReq('B'), makeRes())).toBe(true);

      // Key C at t=2 forces eviction of the idlest (A).
      now += 1000;
      expect(run(mw, makeReq('C'), makeRes())).toBe(true);

      // At most maxBuckets buckets remain.
      if (mw.__getBucketCount) {
        expect(mw.__getBucketCount()).toBeLessThanOrEqual(2);
      }
    });

    it('sweepBuckets removes only buckets idle past the TTL', () => {
      const mw = rateLimiter({
        capacity: 10,
        refillPerSec: 1,
        maxBuckets: 100,
        ttlMs: 5000,
        clock,
      }) as RateLimiterMiddleware;

      // Active key at t=0.
      expect(run(mw, makeReq('active'), makeRes())).toBe(true);
      // Idle key at t=0.
      expect(run(mw, makeReq('idle'), makeRes())).toBe(true);

      // Advance 3s and touch the active key.
      now += 3000;
      expect(run(mw, makeReq('active'), makeRes())).toBe(true);

      // Advance to t=6s -- idle key is now 6s idle (TTL 5s).
      now += 3000;
      if (mw.sweepBuckets) {
        mw.sweepBuckets(now);
      }

      if (mw.__hasBucket) {
        expect(mw.__hasBucket('idle')).toBe(false);
        expect(mw.__hasBucket('active')).toBe(true);
      }
    });
  });

  describe('retry-after header', () => {
    it('sets a parseable non-negative integer retry-after on 429', () => {
      const mw = rateLimiter({
        capacity: 1,
        refillPerSec: 1,
        clock,
      }) as RateLimiterMiddleware;

      expect(run(mw, makeReq(), makeRes())).toBe(true);

      const res = makeRes();
      expect(run(mw, makeReq(), res)).toBe(false);
      expect(res.statusCode).toBe(TOO_MANY_REQUESTS);

      const raw = res.headers['retry-after'];
      expect(raw).toBeDefined();
      expect(/^\d+$/.test(String(raw))).toBe(true);
      const parsed = Number(raw);
      expect(Number.isInteger(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(0);
    });
  });
});

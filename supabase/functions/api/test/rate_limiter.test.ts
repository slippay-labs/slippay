import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono, type Context } from "hono";
import {
  rateLimit,
  sweepBuckets,
  __resetBuckets,
  __getBucketCount,
  __hasBucket,
  __getBucket,
  __setClock,
} from "../middleware/rate_limit.ts";

function createMockApp(
  maxBuckets = 50,
  capacity = 10,
  refillPerSec = 1,
  now?: () => number,
) {
  const app = new Hono();
  app.use(
    "*",
    rateLimit({
      capacity,
      refillPerSec,
      maxBuckets,
      now,
      scope: "test",
      key: (c: Context) => c.req.header("x-client-id") ?? "anon",
    }),
  );
  app.get("/ping", (c) => c.text("pong"));
  return app;
}

Deno.test("rate_limiter enforces hard maximum bucket count with LRU eviction", async () => {
  __resetBuckets();
  const maxBuckets = 20;
  const app = createMockApp(maxBuckets, 10, 1);

  // Send requests from 50 distinct keys (exceeding maxBuckets of 20)
  for (let i = 0; i < 50; i++) {
    const res = await app.request("/ping", {
      headers: { "x-client-id": `client_${i}` },
    });
    assertEquals(res.status, 200);
  }

  // Assert that total tracked buckets never exceeds the configured cap
  const count = __getBucketCount();
  assertEquals(count <= maxBuckets, true);
  assertEquals(count, maxBuckets);

  // Oldest clients (e.g. client_0) should have been evicted
  assertEquals(__hasBucket("test:client_0"), false);
  assertEquals(__hasBucket("test:client_1"), false);

  // Most recent clients should still be present
  assertEquals(__hasBucket("test:client_49"), true);
  assertEquals(__hasBucket("test:client_48"), true);

  __resetBuckets();
});

Deno.test("rate_limiter does not evict the currently-active bucket during burst from other keys", async () => {
  __resetBuckets();
  const maxBuckets = 10;
  // Set capacity high enough so client_A does not exhaust tokens across its 11 touches
  const app = createMockApp(maxBuckets, 25, 1);

  // Client A is active
  await app.request("/ping", { headers: { "x-client-id": "client_A" } });
  assertEquals(__hasBucket("test:client_A"), true);

  // Flood with other distinct clients, but keep touching client_A periodically
  for (let i = 0; i < 30; i++) {
    await app.request("/ping", { headers: { "x-client-id": `flood_${i}` } });
    if (i % 3 === 0) {
      // Re-access client_A to refresh its LRU position
      const res = await app.request("/ping", { headers: { "x-client-id": "client_A" } });
      assertEquals(res.status, 200);
    }
  }

  // client_A must NOT have been evicted despite flood exceeding maxBuckets by 3x
  assertEquals(__hasBucket("test:client_A"), true);
  assertEquals(__getBucketCount() <= maxBuckets, true);

  __resetBuckets();
});

Deno.test("rate_limiter bounds memory growth across 100k distinct keys", async () => {
  __resetBuckets();
  const maxBuckets = 100;
  const app = createMockApp(maxBuckets, 10, 1);

  // Simulate flood of 100,000 distinct spoofed IP keys
  for (let i = 0; i < 100_000; i++) {
    await app.request("/ping", { headers: { "x-client-id": `spoof_${i}` } });
  }

  // Assert hard bound is strictly respected
  const finalCount = __getBucketCount();
  assertEquals(finalCount, maxBuckets);

  __resetBuckets();
});

Deno.test("rate_limiter asserts refill and capacity cap behaviour with an injected clock", async () => {
  __resetBuckets();
  let currentTime = 1_700_000_000_000; // Fixed deterministic start epoch ms
  const clock = () => currentTime;

  const capacity = 4;
  const refillPerSec = 2; // 2 tokens per second (1 token per 500ms)
  const app = createMockApp(10, capacity, refillPerSec, clock);

  // 1. Consume all 4 initial tokens
  for (let i = 0; i < capacity; i++) {
    const res = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
    assertEquals(res.status, 200);
  }

  // Next request within the same millisecond must be rejected with 429
  const exhaustedRes = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
  assertEquals(exhaustedRes.status, 429);

  // 2. Advance clock by 1500ms -> should refill exactly 1.5 * 2 = 3 tokens
  currentTime += 1500;

  // We should now be able to consume exactly 3 tokens
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
    assertEquals(res.status, 200);
  }

  // 4th request must be rejected
  const exhaustedRes2 = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
  assertEquals(exhaustedRes2.status, 429);

  // 3. Advance clock by a long duration (100 seconds) -> should cap strictly at capacity (4 tokens)
  currentTime += 100_000;

  // We should be able to consume exactly 4 tokens (never 4 + 200 tokens)
  for (let i = 0; i < 4; i++) {
    const res = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
    assertEquals(res.status, 200);
  }

  // 5th request must be 429 rate limited
  const overCapRes = await app.request("/ping", { headers: { "x-client-id": "user_refill" } });
  assertEquals(overCapRes.status, 429);

  __resetBuckets();
});

Deno.test("rate_limiter eviction branch removes victim when maxBuckets is reached", async () => {
  __resetBuckets();
  const maxBuckets = 2;
  const app = createMockApp(maxBuckets, 10, 1);

  // Populate key1 and key2
  await app.request("/ping", { headers: { "x-client-id": "victim_key1" } });
  await app.request("/ping", { headers: { "x-client-id": "victim_key2" } });
  assertEquals(__getBucketCount(), 2);
  assertEquals(__hasBucket("test:victim_key1"), true);
  assertEquals(__hasBucket("test:victim_key2"), true);

  // Adding key3 should trigger the eviction branch, removing victim_key1
  await app.request("/ping", { headers: { "x-client-id": "survivor_key3" } });
  assertEquals(__getBucketCount(), 2);
  assertEquals(__hasBucket("test:victim_key1"), false); // evicted
  assertEquals(__hasBucket("test:victim_key2"), true);
  assertEquals(__hasBucket("test:survivor_key3"), true);

  __resetBuckets();
});

Deno.test("rate_limiter capacity fail-closed branch returns 429 when maxBuckets is 0", async () => {
  __resetBuckets();
  const maxBuckets = 0;
  const app = createMockApp(maxBuckets, 10, 1);

  const res = await app.request("/ping", { headers: { "x-client-id": "blocked_user" } });
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, "rate_limited");
  assertEquals(body.reason, "capacity_exceeded");
  assertEquals(body.retry_after_sec, 1);
  assertEquals(res.headers.get("retry-after"), "1");

  __resetBuckets();
});

Deno.test("rate_limiter retry-after is asserted to be a parseable non-negative integer string", async () => {
  __resetBuckets();
  const app = createMockApp(100, 1, 0.5);

  // Request 1: 200
  await app.request("/ping", { headers: { "x-client-id": "retry_after_user" } });

  // Request 2: 429 rate limited
  const res = await app.request("/ping", { headers: { "x-client-id": "retry_after_user" } });
  assertEquals(res.status, 429);

  const retryAfter = res.headers.get("retry-after");
  assertNotEquals(retryAfter, null);

  // Acceptance criteria: Must be parseable non-negative integer string
  assertEquals(/^\d+$/.test(retryAfter!), true);
  const parsedInt = parseInt(retryAfter!, 10);
  assertEquals(Number.isInteger(parsedInt) && parsedInt >= 0, true);

  const body = await res.json();
  assertEquals(typeof body.retry_after_sec, "number");
  assertEquals(body.retry_after_sec >= 0, true);
  assertEquals(String(body.retry_after_sec), retryAfter);

  __resetBuckets();
});

Deno.test("sweepBuckets removes only buckets idle past the TTL", () => {
  __resetBuckets();
  let time = 1_000_000;
  __setClock(() => time);

  // Create two mock buckets manually
  const ttlMs = 300_000; // 5 minutes
  const app = createMockApp(50, 10, 1, () => time);

  // Key1 created at t = 1,000,000
  app.request("/ping", { headers: { "x-client-id": "idle_key" } });

  // Advance time by 200,000ms (below TTL)
  time += 200_000;
  app.request("/ping", { headers: { "x-client-id": "recent_key" } });

  // Advance time so idle_key has elapsed 350,000ms (> 300,000ms TTL), but recent_key is 150,000ms (< TTL)
  time += 150_000;

  sweepBuckets(ttlMs, time);

  assertEquals(__hasBucket("test:idle_key"), false);
  assertEquals(__hasBucket("test:recent_key"), true);

  __resetBuckets();
});

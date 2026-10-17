import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono, type Context } from "hono";
import {
  rateLimit,
  __resetBuckets,
  __getBucketCount,
  __hasBucket,
  getCapacityRejectionsTotal,
} from "../middleware/rate_limit.ts";

function createMockApp(maxBuckets = 50, capacity = 10, refillPerSec = 1) {
  const app = new Hono();
  app.use(
    "*",
    rateLimit({
      capacity,
      refillPerSec,
      maxBuckets,
      scope: "test",
      key: (c: Context) => c.req.header("x-client-id") ?? "anon",
    }),
  );
  app.get("/ping", (c) => c.text("pong"));
  return app;
}

Deno.test("rate_limiter enforces admission control and rejects new keys at capacity (Issue #192)", async () => {
  __resetBuckets();
  const maxBuckets = 20;
  const app = createMockApp(maxBuckets, 10, 1);

  // Send requests from 20 distinct keys -> all 20 accepted
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/ping", {
      headers: { "x-client-id": `client_${i}` },
    });
    assertEquals(res.status, 200);
  }

  // Next 30 requests from new keys -> all rejected with 429 capacity_exceeded
  for (let i = 20; i < 50; i++) {
    const res = await app.request("/ping", {
      headers: { "x-client-id": `client_${i}` },
    });
    assertEquals(res.status, 429);
    const body = await res.json();
    assertEquals(body.error, "rate_limited");
    assertEquals(body.reason, "capacity_exceeded");
  }

  // Assert that total tracked buckets equals maxBuckets
  const count = __getBucketCount();
  assertEquals(count, maxBuckets);

  // Original clients should NOT have been evicted!
  assertEquals(__hasBucket("test:client_0"), true);
  assertEquals(__hasBucket("test:client_1"), true);
  assertEquals(__hasBucket("test:client_19"), true);

  // Rejected clients were never tracked
  assertEquals(__hasBucket("test:client_20"), false);
  assertEquals(__hasBucket("test:client_49"), false);

  // Metric counts all 30 capacity rejections
  assertEquals(getCapacityRejectionsTotal(), 30);

  __resetBuckets();
});

Deno.test("flooding with new keys cannot restore an existing key's spent budget (Issue #192)", async () => {
  __resetBuckets();
  const maxBuckets = 10;
  const app = createMockApp(maxBuckets, 2, 0.01); // 2 tokens capacity, slow refill

  // Client A exhausts their 2 tokens
  const res1 = await app.request("/ping", { headers: { "x-client-id": "client_A" } });
  assertEquals(res1.status, 200);
  const res2 = await app.request("/ping", { headers: { "x-client-id": "client_A" } });
  assertEquals(res2.status, 200);
  const res3 = await app.request("/ping", { headers: { "x-client-id": "client_A" } });
  assertEquals(res3.status, 429); // Client A is now rate-limited

  // Fill up table to capacity (maxBuckets = 10) with 9 other clients
  for (let i = 0; i < 9; i++) {
    const res = await app.request("/ping", { headers: { "x-client-id": `legit_${i}` } });
    assertEquals(res.status, 200);
  }
  assertEquals(__getBucketCount(), maxBuckets);

  // Flood attack with 50 spoofed distinct keys attempting to evict client_A
  for (let i = 0; i < 50; i++) {
    const res = await app.request("/ping", { headers: { "x-client-id": `spoof_${i}` } });
    assertEquals(res.status, 429);
    const body = await res.json();
    assertEquals(body.reason, "capacity_exceeded");
  }

  // Client A requests again: client_A must NOT have been evicted or reset!
  const resA = await app.request("/ping", { headers: { "x-client-id": "client_A" } });
  assertEquals(resA.status, 429);
  const bodyA = await resA.json();
  assertEquals(bodyA.error, "rate_limited");
  assertEquals(bodyA.reason, undefined); // Standard rate limit, not capacity_exceeded

  // Table remains bound to maxBuckets and client_A is still tracked
  assertEquals(__hasBucket("test:client_A"), true);
  assertEquals(__getBucketCount(), maxBuckets);

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

Deno.test("rate_limiter returns 429 when capacity is exhausted", async () => {
  __resetBuckets();
  const app = createMockApp(100, 2, 0.1);

  // Request 1: ok (tokens remaining: 1)
  const res1 = await app.request("/ping", { headers: { "x-client-id": "limited_user" } });
  assertEquals(res1.status, 200);

  // Request 2: ok (tokens remaining: 0)
  const res2 = await app.request("/ping", { headers: { "x-client-id": "limited_user" } });
  assertEquals(res2.status, 200);

  // Request 3: 429 rate limited
  const res3 = await app.request("/ping", { headers: { "x-client-id": "limited_user" } });
  assertEquals(res3.status, 429);
  const body = await res3.json();
  assertEquals(body.error, "rate_limited");
  assertNotEquals(res3.headers.get("retry-after"), null);

  __resetBuckets();
});

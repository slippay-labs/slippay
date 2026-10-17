import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getBrlPerUsdc,
  getBrlPerUsdcObservation,
  refreshBrlRate,
  MemorySharedRateStore,
  DatabaseRateStore,
  RATE_TTL_MS,
  _resetCacheForTest,
} from "../lib/rate.ts";

Deno.test("getBrlPerUsdc returns positive number from CoinGecko fallback", { sanitizeOps: false, sanitizeResources: false }, async () => {
  _resetCacheForTest();
  const r = await getBrlPerUsdc();
  assert(r > 0);
});

Deno.test("getBrlPerUsdc caches within ttl", { sanitizeOps: false, sanitizeResources: false }, async () => {
  _resetCacheForTest();
  const a = await getBrlPerUsdc();
  const b = await getBrlPerUsdc();
  assertEquals(a, b);
});

// Acceptance Criteria 1: All workers serving a request within the cache window observe the same rate
Deno.test("all simulated isolates observe the exact same rate and audit metadata within cache window", async () => {
  const sharedStore = new MemorySharedRateStore();
  let upstreamFetchCount = 0;
  const mockUpstream = async () => {
    upstreamFetchCount++;
    return 5.6789;
  };

  // Simulate 5 independent serverless workers / cold isolates
  const simulateWorker = async () => {
    return await getBrlPerUsdcObservation(undefined, sharedStore, mockUpstream);
  };

  const results = await Promise.all([
    simulateWorker(),
    simulateWorker(),
    simulateWorker(),
    simulateWorker(),
    simulateWorker(),
  ]);

  // All workers must observe the identical rate and timestamp
  const first = results[0];
  assertEquals(first.rate, 5.6789);
  assertEquals(first.source, "coingecko");
  assert(first.observedAt);

  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i].rate, first.rate);
    assertEquals(results[i].observedAt, first.observedAt);
  }
  // Upstream should only be hit once across all isolates
  assertEquals(upstreamFetchCount, 1);
});

// Acceptance Criteria 2: A cold isolate does not trigger an upstream call when a fresh shared value exists
Deno.test("a cold isolate does not trigger upstream call when a fresh shared value exists", async () => {
  const sharedStore = new MemorySharedRateStore();
  const observedAt = new Date().toISOString();
  await sharedStore.set({
    pair: "BRL_USDC",
    rate: 5.75,
    source: "scheduled_cron",
    observed_at: observedAt,
  });

  let upstreamCalled = false;
  const failingUpstream = async () => {
    upstreamCalled = true;
    throw new Error("Should never be called by a cold isolate when cache is warm");
  };

  // Simulate a cold isolate with zero module state
  const obs = await getBrlPerUsdcObservation(undefined, sharedStore, failingUpstream);
  assertEquals(obs.rate, 5.75);
  assertEquals(obs.source, "scheduled_cron");
  assertEquals(obs.observedAt, observedAt);
  assertEquals(upstreamCalled, false);
});

// Acceptance Criteria 3: Cold isolate refreshes when shared rate is expired
Deno.test("cold isolate fetches new rate when shared store rate is older than TTL", async () => {
  const sharedStore = new MemorySharedRateStore();
  const staleTime = new Date(Date.now() - RATE_TTL_MS - 5000).toISOString();
  await sharedStore.set({
    pair: "BRL_USDC",
    rate: 5.20,
    source: "stale_coingecko",
    observed_at: staleTime,
  });

  let upstreamCalls = 0;
  const freshUpstream = async () => {
    upstreamCalls++;
    return 5.85;
  };

  const obs = await getBrlPerUsdcObservation(undefined, sharedStore, freshUpstream);
  assertEquals(obs.rate, 5.85);
  assertEquals(upstreamCalls, 1);
  assertEquals(obs.source, "coingecko");

  // Verify shared store was updated
  const stored = await sharedStore.get("BRL_USDC");
  assertEquals(stored?.rate, 5.85);
});

// Scheduled warm refresh capability
Deno.test("refreshBrlRate warms up shared store", async () => {
  const sharedStore = new MemorySharedRateStore();
  const mockFetch = async () => 5.92;
  const record = await refreshBrlRate(sharedStore, mockFetch);
  assertEquals(record.rate, 5.92);

  const cached = await sharedStore.get("BRL_USDC");
  assertEquals(cached?.rate, 5.92);
});

// DatabaseRateStore mapping and fault tolerance
Deno.test("DatabaseRateStore reads and writes with SupabaseClient mock", async () => {
  let tableQueried = "";
  let upsertPayload: unknown = null;
  const mockSb = {
    from: (tbl: string) => {
      tableQueried = tbl;
      return {
        select: (_fields: string) => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => ({
              data: {
                pair: val,
                rate: "5.88",
                source: "coingecko",
                observed_at: "2026-10-17T00:00:00Z",
              },
              error: null,
            }),
          }),
        }),
        upsert: async (payload: unknown) => {
          upsertPayload = payload;
          return { error: null };
        },
      };
    },
  } as unknown as import("supabase").SupabaseClient;

  const dbStore = new DatabaseRateStore(mockSb);
  const rec = await dbStore.get("BRL_USDC");
  assertEquals(tableQueried, "fx_rates");
  assertEquals(rec?.rate, 5.88);
  assertEquals(rec?.source, "coingecko");

  await dbStore.set({
    pair: "BRL_USDC",
    rate: 5.90,
    source: "test_writer",
    observed_at: "2026-10-17T01:00:00Z",
  });
  assert(upsertPayload);
});


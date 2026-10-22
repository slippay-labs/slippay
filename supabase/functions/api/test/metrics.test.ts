import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { req } from "./_helpers.ts";
import { clearMetricCache, DEFAULT_CONTRACT_ID } from "../routes/metrics.ts";

const originalFetch = globalThis.fetch;

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      Deno.env.delete(k);
    } else {
      Deno.env.set(k, v);
    }
  }
}

Deno.test("GET /metrics/dune-snapshot - returns configured: false when unconfigured", async () => {
  clearMetricCache();
  const saved = {
    DUNE_API_KEY: Deno.env.get("DUNE_API_KEY"),
    DUNE_Q_ACTIVE: Deno.env.get("DUNE_Q_ACTIVE"),
    DUNE_Q_MRR: Deno.env.get("DUNE_Q_MRR"),
    DUNE_Q_CHURN: Deno.env.get("DUNE_Q_CHURN"),
    DUNE_Q_COHORT: Deno.env.get("DUNE_Q_COHORT"),
    STELLAR_NETWORK: Deno.env.get("STELLAR_NETWORK"),
    SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET: Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET"),
  };

  try {
    Deno.env.delete("DUNE_API_KEY");
    Deno.env.delete("DUNE_Q_ACTIVE");
    Deno.env.delete("DUNE_Q_MRR");
    Deno.env.delete("DUNE_Q_CHURN");
    Deno.env.delete("DUNE_Q_COHORT");
    Deno.env.set("STELLAR_NETWORK", "mainnet");

    const res = await req("/v1/metrics/dune-snapshot");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.configured, false);
    assertEquals(body.contract_id, DEFAULT_CONTRACT_ID);
    assertEquals(body.network, "mainnet");
    assertEquals(body.dashboard_url, "https://dune.com/slippay/subscription-intelligence");
    assertNotEquals(body.note, undefined);
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("GET /metrics/dune-snapshot - respects contract id from configuration", async () => {
  clearMetricCache();
  const saved = {
    DUNE_API_KEY: Deno.env.get("DUNE_API_KEY"),
    STELLAR_NETWORK: Deno.env.get("STELLAR_NETWORK"),
    SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET: Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET"),
  };

  try {
    Deno.env.delete("DUNE_API_KEY");
    Deno.env.set("STELLAR_NETWORK", "testnet");
    Deno.env.set("SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET", "C_CUSTOM_TESTNET_CONTRACT_789");

    const res = await req("/v1/metrics/dune-snapshot");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.contract_id, "C_CUSTOM_TESTNET_CONTRACT_789");
    assertEquals(body.network, "testnet");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("GET /metrics/dune-snapshot - does not cache a failed read and retries on next request", async () => {
  clearMetricCache();
  const saved = {
    DUNE_API_KEY: Deno.env.get("DUNE_API_KEY"),
    DUNE_Q_ACTIVE: Deno.env.get("DUNE_Q_ACTIVE"),
    DUNE_Q_MRR: Deno.env.get("DUNE_Q_MRR"),
    DUNE_Q_CHURN: Deno.env.get("DUNE_Q_CHURN"),
    DUNE_Q_COHORT: Deno.env.get("DUNE_Q_COHORT"),
  };

  let mrrAttempts = 0;
  let activeAttempts = 0;

  // Mock global fetch to simulate Dune API
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/query/q_active/results")) {
      activeAttempts++;
      return new Response(JSON.stringify({ result: { rows: [{ active: 100 }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/query/q_mrr/results")) {
      mrrAttempts++;
      if (mrrAttempts === 1) {
        // First attempt fails with transient 504 / timeout
        return new Response("Gateway Timeout error internal details http://dune-backend-error", {
          status: 504,
        });
      }
      // Second attempt succeeds
      return new Response(JSON.stringify({ result: { rows: [{ mrr: 5000 }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    Deno.env.set("DUNE_API_KEY", "test-dune-key");
    Deno.env.set("DUNE_Q_ACTIVE", "q_active");
    Deno.env.set("DUNE_Q_MRR", "q_mrr");
    Deno.env.delete("DUNE_Q_CHURN");
    Deno.env.delete("DUNE_Q_COHORT");

    // First request: active succeeds, mrr fails
    const res1 = await req("/v1/metrics/dune-snapshot");
    assertEquals(res1.status, 200);
    const body1 = await res1.json();
    assertEquals(body1.configured, true);
    assertEquals(body1.metrics.active_subscriptions, [{ active: 100 }]);

    // Acceptance criterion: Machine-readable error, no raw exception strings
    assertEquals(body1.metrics.mrr_usd, { error: "upstream_unavailable" });
    const rawBody1 = JSON.stringify(body1);
    assertEquals(rawBody1.includes("504"), false);
    assertEquals(rawBody1.includes("Gateway Timeout"), false);
    assertEquals(rawBody1.includes("dune-backend-error"), false);

    assertEquals(activeAttempts, 1);
    assertEquals(mrrAttempts, 1);

    // Second request: active should hit cache, mrr should retry and succeed!
    const res2 = await req("/v1/metrics/dune-snapshot");
    assertEquals(res2.status, 200);
    const body2 = await res2.json();
    assertEquals(body2.configured, true);
    assertEquals(body2.metrics.active_subscriptions, [{ active: 100 }]);

    // Acceptance criterion: A failed metric is not frozen for the full TTL; next request returns data
    assertEquals(body2.metrics.mrr_usd, [{ mrr: 5000 }]);

    // Verify cache behavior: active was not refetched (attempts still 1), mrr was retried (attempts = 2)
    assertEquals(activeAttempts, 1);
    assertEquals(mrrAttempts, 2);

    // Third request: both metrics should now be served from cache
    const res3 = await req("/v1/metrics/dune-snapshot");
    assertEquals(res3.status, 200);
    const body3 = await res3.json();
    assertEquals(body3.metrics.mrr_usd, [{ mrr: 5000 }]);
    assertEquals(activeAttempts, 1);
    assertEquals(mrrAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

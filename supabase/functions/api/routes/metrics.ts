import { Hono } from "hono";

// Public subscription-intelligence snapshot, sourced from the SlipPay Dune
// dashboard (dune.com/slippay/subscription-intelligence). Public on purpose —
// the whole thesis is "verifiable on-chain, audit it yourself", so no auth.
//
// Two-layer honesty contract:
//   1. If the Dune query IDs / API key aren't configured yet, we return
//      { configured: false } — never fabricated numbers. Per Wave's rule,
//      the dashboard isn't published until >=1 real mainnet charge exists,
//      so this is the expected state until then.
//   2. When configured, we cache successful Dune results for 1h (TTL) so the site can
//      poll cheaply and Dune's rate limit isn't hit on every pageview.
//      Failed metrics are NEVER cached for the full TTL, so the next request can
//      retry without waiting out the hour or restarting the server.
//
// GET /v1/metrics/dune-snapshot
const r = new Hono();

export const DASHBOARD_URL = "https://dune.com/slippay/subscription-intelligence";
export const DEFAULT_CONTRACT_ID = "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN";
export const TTL_MS = 60 * 60 * 1000; // 1h

export function getStellarNetwork(): "testnet" | "mainnet" {
  return (Deno.env.get("STELLAR_NETWORK")?.toLowerCase() ?? "mainnet") as "testnet" | "mainnet";
}

export function getConfiguredContractId(): string {
  const net = getStellarNetwork();
  const envContract = net === "mainnet"
    ? (Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET") ?? Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT"))
    : (Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET") ?? Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT"));
  return envContract ?? DEFAULT_CONTRACT_ID;
}

export function getQueryIds(): Record<string, string> {
  return {
    active_subscriptions: Deno.env.get("DUNE_Q_ACTIVE") ?? "",
    mrr_usd: Deno.env.get("DUNE_Q_MRR") ?? "",
    churn_30d: Deno.env.get("DUNE_Q_CHURN") ?? "",
    cohort_retention: Deno.env.get("DUNE_Q_COHORT") ?? "",
  };
}

interface MetricCacheEntry {
  at: number;
  data: unknown;
}

// Per-metric cache: only successful responses are cached with TTL.
// A failing metric is never stored here so the subsequent request can retry.
const metricCache = new Map<string, MetricCacheEntry>();

export function clearMetricCache(): void {
  metricCache.clear();
}

export async function fetchDuneLatest(queryId: string, apiKey: string): Promise<unknown> {
  // Latest cached execution result — does not trigger a new run (cheap + fast).
  const res = await fetch(`https://api.dune.com/api/v1/query/${queryId}/results`, {
    headers: { "X-Dune-API-Key": apiKey },
  });
  if (!res.ok) throw new Error(`dune ${queryId} -> ${res.status}`);
  const json = await res.json();
  // Single-value queries return one row; we surface rows verbatim and let the
  // caller pick. Keeps the endpoint dumb — no metric-specific shaping here.
  return json?.result?.rows ?? [];
}

r.get("/dune-snapshot", async (c) => {
  const apiKey = Deno.env.get("DUNE_API_KEY") ?? "";
  const queryIds = getQueryIds();
  const wired = Object.values(queryIds).filter(Boolean).length;
  const contractId = getConfiguredContractId();
  const network = getStellarNetwork();

  // Honest unconfigured state — no fabricated numbers.
  if (!apiKey || wired === 0) {
    return c.json({
      configured: false,
      contract_id: contractId,
      network,
      dashboard_url: DASHBOARD_URL,
      note: "Dashboard not published yet — published once real mainnet subscription data exists.",
    });
  }

  const now = Date.now();
  const metrics: Record<string, unknown> = {};

  for (const [name, id] of Object.entries(queryIds)) {
    if (!id) {
      metrics[name] = null;
      continue;
    }

    const cached = metricCache.get(name);
    if (cached && now - cached.at < TTL_MS) {
      metrics[name] = cached.data;
      continue;
    }

    try {
      const data = await fetchDuneLatest(id, apiKey);
      metricCache.set(name, { at: now, data });
      metrics[name] = data;
    } catch (e: unknown) {
      // Log server-side for diagnostics, but never expose raw exception strings or status
      // on the public endpoint.
      console.error(`Failed to fetch Dune metric ${name} (${id}):`, e);
      metrics[name] = { error: "upstream_unavailable" };
      // Do NOT set in metricCache! The next request will retry.
    }
  }

  const body = {
    configured: true,
    contract_id: contractId,
    network,
    dashboard_url: DASHBOARD_URL,
    fetched_at: new Date(now).toISOString(),
    metrics,
  };

  return c.json(body);
});

export default r;

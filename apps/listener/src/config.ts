function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const rawNetwork = (process.env.STELLAR_NETWORK ?? "TESTNET").toUpperCase() as "TESTNET" | "PUBLIC";

export const config = {
  supabaseUrl: need("SUPABASE_URL"),
  supabaseServiceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  network: rawNetwork,
  // The merchants.network column stores "testnet"|"mainnet" (lowercase). The
  // listener must only watch merchants on the SAME network it streams, or it
  // tries to stream a testnet address against mainnet Horizon (or vice-versa)
  // and the stream errors forever. Map the Stellar-facing shape to that column.
  merchantNetwork: rawNetwork === "TESTNET" ? "testnet" : "mainnet",
  // Fail-closed gating flag: anything not explicitly TESTNET is treated as
  // mainnet. `network` keeps its Stellar-facing "TESTNET" | "PUBLIC" shape (used
  // by horizon/manager); this flag is the one the SSRF guard keys off of so a
  // PUBLIC network can never silently disable the webhook blocklist (audit-003).
  isMainnet: rawNetwork !== "TESTNET",
  // Dev-only escape hatch. When "1", permits http/localhost/RFC1918 webhook
  // targets so local mock servers work in tests. NEVER set in production.
  allowLocalWebhooks: (process.env.ALLOW_LOCAL_WEBHOOKS ?? "") === "1",
  merchantPollMs: Number(process.env.MERCHANT_POLL_MS ?? "30000"),
  // Health/metrics HTTP surface. The listener is a deployed process whose
  // silent failure mode is not crediting payments, so it needs a liveness
  // signal an orchestrator can act on. Defaults keep the port stable across
  // deploys; bind to all interfaces so Fly/Docker health checks can reach it.
  healthPort: Number(process.env.HEALTH_PORT ?? "8080"),
  healthHost: process.env.HEALTH_HOST ?? "0.0.0.0",
  // How long a lease may be held past its expiry before the health check
  // treats the account as unwatched. Guards against clock skew between the
  // listener and the DB when comparing lease_expires_at to now().
  leaseExpiryGraceMs: Number(process.env.LEASE_EXPIRY_GRACE_MS ?? "5000"),
};

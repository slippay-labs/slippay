function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const rawNetwork = (process.env.STELLAR_NETWORK ?? "TESTNET").toUpperCase() as "TESTNET" | "PUBLIC";

const isMainnet = rawNetwork !== "TESTNET";
const allowLocalRaw = (process.env.ALLOW_LOCAL_WEBHOOKS ?? "").trim();
const allowLocalWebhooks = allowLocalRaw === "1";
const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
const isProduction = nodeEnv === "production" || isMainnet;

// Security interlock (Issue #249 / Audit-003):
// allowLocalWebhooks bypasses the SSRF guard and outbound hostname/IP checks.
// Refuse to boot in any production configuration if this escape hatch is active.
if (allowLocalWebhooks && isProduction) {
  const reason = isMainnet ? `STELLAR_NETWORK=${rawNetwork}` : `NODE_ENV=${process.env.NODE_ENV}`;
  throw new Error(
    `ALLOW_LOCAL_WEBHOOKS cannot be enabled in production environments (${reason}). ` +
    `SSRF escape hatch is restricted to non-production TESTNET environments only.`
  );
}

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
  // mainnet. `network` keeps its Stellar-facing "TESTNET"|"PUBLIC" shape (used
  // by horizon/manager); this flag is the one the SSRF guard keys off of so a
  // PUBLIC network can never silently disable the webhook blocklist (audit-003).
  isMainnet,
  // Dev-only escape hatch. When "1", permits http/localhost/RFC1918 webhook
  // targets so local mock servers work in tests. NEVER set in production.
  allowLocalWebhooks,
  merchantPollMs: Number(process.env.MERCHANT_POLL_MS ?? "30000"),
};

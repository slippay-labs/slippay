function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const rawNetwork = (process.env.STELLAR_NETWORK ?? "TESTNET").toUpperCase() as "TESTNET" | "PUBLIC";

// A security bypass controlled by configuration needs an interlock and a
// visible state. The dev-only webhook escape hatch is now gated on an
// explicit override value (rather than a boolean) and refuses to start in
// production.
const ALLOW_LOCAL_WEBHOOKS_ACTIVATION_VALUE = "dev-only-allow-local-webhooks";

function resolveAllowLocalWebhooks(): boolean {
  const raw = (process.env.ALLOW_LOCAL_WEBHOOKS ?? "").trim();
  if (raw === "") return false;
  if (raw !== ALLOW_LOCAL_WEBHOOKS_ACTIVATION_VALUE) {
    throw new Error(
      `ALLOW_LOCAL_WEBHOOKS is set to an unrecognised value. The dev-only webhook escape hatch requires the explicit override value '${ALLOW_LOCAL_WEBHOOKS_ACTIVATION_VALUE}'.`,
    );
  }
  return true;
}

function isProductionRuntime(): boolean {
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  return nodeEnv === "production";
}

const allowLocalWebhooks = resolveAllowLocalWebhooks();

if (allowLocalWebhooks && isProductionRuntime()) {
  throw new Error(
    "Fail-closed: ALLOW_LOCAL_WEBHOOKS is enabled but the runtime reports a production environment (NODE_ENV=production). The local webhook escape hatch disables SSFR protections and must not be active in production.",
  );
}

if (allowLocalWebhooks) {
  console.warn(
    "[SECURITY] ALLOW_LOCAL_WEBHOOKS is ACTIVE: the dev-only webhook escape hatch is on and SSRF protections for outbound webhook requests are relaxed. Never enable this in production.",
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
  // mainnet. `network` keeps its Stellar-facing "TESTNET" | "PUBLIC" shape (used
  // by horizon/manager); this flag is the one the SSRF guard keys off of so a
  // PUBLIC network can never silently disable the webhook blocklist (audit-003).
  isMainnet: rawNetwork !== "TESTNET",
  // Dev-only escape hatch. When enabled via the explicit override value, permits
  // http/localhost/RFC1918 webhook targets so local mock servers work in tests.
  // NEVER set in production.
  allowLocalWebhooks,
  merchantPollMs: Number(process.env.MERCHANT_POLL_MS ?? "30000"),
};

export const securityStatus = {
  allowLocalWebhooks,
  allowLocalWebhooksActive: allowLocalWebhooks,
  productionRuntime: isProductionRuntime(),
};

export function getHealthSecurity(): {
  allowLocalWebhooks: boolean;
  allowLocalWebhooksActive: boolean;
  productionRuntime: boolean;
} {
  return {
    allowLocalWebhooks,
    allowLocalWebhooksActive: allowLocalWebhooks,
    productionRuntime: isProductionRuntime(),
  };
}

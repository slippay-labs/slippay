import { describe, it, expect, vi, afterEach } from "vitest";

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STELLAR_NETWORK",
  "ALLOW_LOCAL_WEBHOOKS",
  "NODE_ENV",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

const REQUIRED = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.resetModules();
});

describe("health · getHealthStatus (Issue #249)", () => {
  it("returns status=ok when allowLocalWebhooks is false", async () => {
    clearEnv();
    for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
    vi.resetModules();
    const { getHealthStatus } = await import("../src/health.js");
    const h = getHealthStatus();
    expect(h.status).toBe("ok");
    expect(h.allowLocalWebhooks).toBe(false);
    expect(h.warnings).toBeUndefined();
  });

  it("returns status=degraded with warning when allowLocalWebhooks is true in dev mode", async () => {
    clearEnv();
    for (const [k, v] of Object.entries({
      ...REQUIRED,
      NODE_ENV: "development",
      STELLAR_NETWORK: "TESTNET",
      ALLOW_LOCAL_WEBHOOKS: "1",
    })) {
      process.env[k] = v;
    }
    vi.resetModules();
    const { getHealthStatus } = await import("../src/health.js");
    const h = getHealthStatus();
    expect(h.status).toBe("degraded");
    expect(h.allowLocalWebhooks).toBe(true);
    expect(h.warnings).toBeDefined();
    expect(h.warnings?.[0]).toContain("ALLOW_LOCAL_WEBHOOKS is enabled");
  });
});

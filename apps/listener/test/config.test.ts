import { describe, it, expect, vi, afterEach } from "vitest";

// config.ts reads process.env at module-evaluation time, so each case clears the
// relevant keys, sets the ones under test, resets the module registry, and
// re-imports. afterEach restores the original env so nothing leaks between cases.
const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STELLAR_NETWORK",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function loadConfig(env: Record<string, string> = {}) {
  clearEnv();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const mod = await import("../src/config.js");
  return mod.config;
}

const REQUIRED = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" };

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.resetModules();
});

describe("config · required env", () => {
  it("throws when SUPABASE_URL is missing", async () => {
    await expect(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: "k" })).rejects.toThrow("missing env SUPABASE_URL");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    await expect(loadConfig({ SUPABASE_URL: "https://proj.supabase.co" })).rejects.toThrow("missing env SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("config · network gating", () => {
  it("defaults to TESTNET and maps it to the lowercase merchant column", async () => {
    const c = await loadConfig(REQUIRED);
    expect(c.network).toBe("TESTNET");
    expect(c.merchantNetwork).toBe("testnet");
    expect(c.isMainnet).toBe(false);
  });

  it("PUBLIC selects mainnet and flips the fail-closed SSRF flag", async () => {
    const c = await loadConfig({ ...REQUIRED, STELLAR_NETWORK: "PUBLIC" });
    expect(c.network).toBe("PUBLIC");
    expect(c.merchantNetwork).toBe("mainnet");
    expect(c.isMainnet).toBe(true);
  });
});

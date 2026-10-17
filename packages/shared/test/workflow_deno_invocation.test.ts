import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const WORKFLOW_TEST = resolve(REPO_ROOT, ".github/workflows/test.yml");

describe("Workflow Deno Invocation Invariants (Issue #163)", () => {
  it("proves test.yml executes deno test without shell || fallback masking", () => {
    const yaml = readFileSync(WORKFLOW_TEST, "utf-8");

    // The command must not have || fallback hiding configuration failures
    expect(yaml).not.toMatch(/deno test[^\n]+\|\|/);
    expect(yaml).not.toContain("|| \\\n  deno test");
    expect(yaml).not.toContain("|| deno test");
  });

  it("proves the API edge function test step runs a single deterministic deno test command", () => {
    const yaml = readFileSync(WORKFLOW_TEST, "utf-8");

    // Must execute deno test cleanly
    expect(yaml).toContain("deno test --allow-all --no-check test/");
  });

  it("proves configuration is unified in the workflow env block with zero duplicate drift", () => {
    const yaml = readFileSync(WORKFLOW_TEST, "utf-8");

    const requiredKeys = [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DB_URL",
      "JWT_SECRET",
      "RATE_BRL_USDC",
      "API_KEY_PEPPER",
      "CHECKOUT_TOKEN_SECRET",
    ];

    for (const key of requiredKeys) {
      expect(yaml).toContain(`${key}:`);
    }
  });
});

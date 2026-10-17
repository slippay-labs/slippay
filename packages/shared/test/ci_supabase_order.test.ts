import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("CI step order and Supabase gating verification (Issue #164)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const testWfPath = resolve(repoRoot, ".github/workflows/test.yml");
  const listenerPkgPath = resolve(repoRoot, "apps/listener/package.json");

  it("verifies test.yml exists", () => {
    expect(existsSync(testWfPath)).toBe(true);
  });

  it("verifies listener package.json defines e2e script", () => {
    expect(existsSync(listenerPkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(listenerPkgPath, "utf-8"));
    expect(pkg.scripts?.e2e).toBeDefined();
    expect(pkg.scripts.e2e).toContain("vitest.e2e.config.ts");
  });

  it("ensures Supabase is started and verified before test steps", () => {
    const content = readFileSync(testWfPath, "utf-8");
    const supabaseStartIndex = content.indexOf("name: Start local Supabase stack");
    const supabaseWaitIndex = content.indexOf("name: Wait for Supabase readiness");
    const workspaceTestsIndex = content.indexOf("name: Workspace tests");
    const listenerE2EIndex = content.indexOf("name: Listener database and E2E tests");
    const edgeFunctionTestsIndex = content.indexOf("name: API edge function tests");

    expect(supabaseStartIndex).toBeGreaterThan(0);
    expect(supabaseWaitIndex).toBeGreaterThan(supabaseStartIndex);
    expect(workspaceTestsIndex).toBeGreaterThan(supabaseWaitIndex);
    expect(listenerE2EIndex).toBeGreaterThan(workspaceTestsIndex);
    expect(edgeFunctionTestsIndex).toBeGreaterThan(listenerE2EIndex);
  });

  it("ensures listener e2e step executes with service role key", () => {
    const content = readFileSync(testWfPath, "utf-8");
    expect(content).toContain("pnpm --filter @slippay/listener e2e");
    expect(content).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("ensures readiness polling checks REST endpoint", () => {
    const content = readFileSync(testWfPath, "utf-8");
    expect(content).toContain("curl -s -f http://127.0.0.1:54321/rest/v1/");
    expect(content).toContain("Supabase REST API is ready");
  });
});

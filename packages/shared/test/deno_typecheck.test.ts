import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("CI Deno typechecking and cache verification (Issue #171)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const testWfPath = resolve(repoRoot, ".github/workflows/test.yml");
  const denoJsonPath = resolve(repoRoot, "supabase/functions/api/deno.json");

  it("verifies test.yml exists", () => {
    expect(existsSync(testWfPath)).toBe(true);
  });

  it("verifies deno.json exists and enables strict typechecking", () => {
    expect(existsSync(denoJsonPath)).toBe(true);
    const denoConfig = JSON.parse(readFileSync(denoJsonPath, "utf-8"));
    expect(denoConfig.compilerOptions?.strict).toBe(true);
    expect(denoConfig.tasks?.check).toContain("deno check");
  });

  it("ensures --no-check is eliminated from test.yml", () => {
    const content = readFileSync(testWfPath, "utf-8");
    expect(content.includes("--no-check")).toBe(false);
  });

  it("ensures deno check step is present in test.yml", () => {
    const content = readFileSync(testWfPath, "utf-8");
    expect(content).toContain("deno check index.ts");
  });

  it("ensures Deno cache step is configured in test.yml", () => {
    const content = readFileSync(testWfPath, "utf-8");
    expect(content).toContain("Cache Deno dependencies");
    expect(content).toContain("actions/cache@");
    expect(content).toContain("~/.cache/deno");
    expect(content).toContain("supabase/functions/api/deno.lock");
  });
});

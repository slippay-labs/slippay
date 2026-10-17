import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

describe("Production environment files tracking & security (Issue #181)", () => {
  const rootDir = resolve(__dirname, "../../..");

  it("ensures no tracked .env* file exists in git other than *.example files", () => {
    const trackedFiles = execSync("git ls-files '*.env*' '*/**/.env*'", {
      cwd: rootDir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    for (const file of trackedFiles) {
      expect(file, `Tracked env file ${file} must end with .example`).toMatch(/\.example$/);
    }
  });

  it("verifies apps/web/.env.production.example exists and contains all required keys", () => {
    const examplePath = resolve(rootDir, "apps/web/.env.production.example");
    expect(existsSync(examplePath)).toBe(true);

    const content = readFileSync(examplePath, "utf-8");
    const requiredKeys = [
      "VITE_API_BASE",
      "VITE_STELLAR_NETWORK",
      "VITE_PLATFORM_ADDRESS",
      "VITE_SUB_CONTRACT",
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_ANON_KEY",
      "VITE_TRANSAK_API_KEY",
      "VITE_4P_OFFRAMP_RECEIVER",
    ];

    for (const key of requiredKeys) {
      expect(content, `Example file must document ${key}`).toContain(key);
    }
  });

  it("asserts apps/web/.env.production is covered by gitignore", () => {
    const checkIgnoreOutput = execSync('git check-ignore "apps/web/.env.production"', {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    expect(checkIgnoreOutput).toBe("apps/web/.env.production");
  });
});

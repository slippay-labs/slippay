import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("CODEOWNERS security audit", () => {
  const root = path.resolve(__dirname, "../../..");
  const codeownersPath = path.join(root, ".github/CODEOWNERS");

  it("ensures .github/CODEOWNERS exists and is readable", () => {
    expect(fs.existsSync(codeownersPath)).toBe(true);
    const content = fs.readFileSync(codeownersPath, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("covers all security-sensitive paths specified in issue #178", () => {
    const content = fs.readFileSync(codeownersPath, "utf-8");
    const requiredPatterns = [
      "supabase/functions/api/lib/apikey.ts",
      "supabase/functions/api/lib/checkout-token.ts",
      "supabase/functions/api/lib/client_ip.ts",
      "apps/listener/src/ssrf.ts",
      "apps/listener/src/crypto.ts",
      "packages/shared/src/schemas/",
      "contracts/*/src/lib.rs",
      ".github/workflows/",
      "pnpm-lock.yaml",
      "postcss.config.*",
      "vite.config.*",
      "eslint.config.js",
      "Cargo.toml",
    ];

    for (const pattern of requiredPatterns) {
      expect(content).toContain(pattern);
    }
  });

  it("ensures all ownership rules map to valid owners starting with @", () => {
    const lines = fs.readFileSync(codeownersPath, "utf-8").split("\n");
    let ruleCount = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const parts = line.split(/\s+/);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const pattern = parts[0];
      const owners = parts.slice(1);

      expect(pattern.length).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(owner.startsWith("@")).toBe(true);
      }
      ruleCount++;
    }

    expect(ruleCount).toBeGreaterThanOrEqual(10);
  });
});

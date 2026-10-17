import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("monorepo connector packages test and lint contract", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const appsDir = resolve(repoRoot, "apps");

  it("verifies apps directory exists", () => {
    expect(existsSync(appsDir)).toBe(true);
  });

  const connectorDirs = existsSync(appsDir)
    ? readdirSync(appsDir).filter((d) => d.endsWith("-connector"))
    : [];

  it("identifies connector packages in apps/", () => {
    expect(connectorDirs).toContain("shopify-connector");
    expect(connectorDirs).toContain("vtex-connector");
  });

  for (const connector of connectorDirs) {
    describe(`contract for ${connector}`, () => {
      const pkgPath = resolve(appsDir, connector, "package.json");

      it(`defines package.json for ${connector}`, () => {
        expect(existsSync(pkgPath)).toBe(true);
      });

      it(`declares test script in ${connector}/package.json`, () => {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts).toBeDefined();
        expect(typeof pkg.scripts.test).toBe("string");
        expect(pkg.scripts.test.length).toBeGreaterThan(0);
      });

      it(`declares lint script in ${connector}/package.json`, () => {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts).toBeDefined();
        expect(typeof pkg.scripts.lint).toBe("string");
        expect(pkg.scripts.lint.length).toBeGreaterThan(0);
        expect(pkg.scripts.lint).toContain("node --check");
      });
    });
  }

  it("verifies vtex-connector test file exists and contains assertions", () => {
    const vtexTestPath = resolve(appsDir, "vtex-connector/test/vtex.test.mjs");
    expect(existsSync(vtexTestPath)).toBe(true);
    const content = readFileSync(vtexTestPath, "utf-8");
    expect(content).toContain("handlePaymentCreate");
    expect(content).toContain("handleSlippayWebhook");
    expect(content).toContain("getManifest");
  });

  it("verifies shopify-connector test suite exists", () => {
    const hmacTestPath = resolve(appsDir, "shopify-connector/test/hmac.test.mjs");
    const e2eTestPath = resolve(appsDir, "shopify-connector/test/e2e.mjs");
    expect(existsSync(hmacTestPath)).toBe(true);
    expect(existsSync(e2eTestPath)).toBe(true);
  });
});

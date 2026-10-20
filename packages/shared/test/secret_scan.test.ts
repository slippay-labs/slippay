import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Secret scanning and full-history credential protection (Issue #183)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const gitleaksConfigPath = resolve(repoRoot, ".gitleaks.toml");
  const workflowPath = resolve(repoRoot, ".github/workflows/secret-scan.yml");

  it("verifies .gitleaks.toml exists in repository root", () => {
    expect(existsSync(gitleaksConfigPath)).toBe(true);
  });

  it("verifies .github/workflows/secret-scan.yml exists", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("verifies full history scanning (fetch-depth: 0) in workflow", () => {
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("fetch-depth: 0");
    expect(content).toContain("gitleaks/gitleaks-action@");
    expect(content).toContain(".gitleaks.toml");
    // Verify 40-character pinned commit SHAs
    const actionLines = content
      .split("\n")
      .filter((l) => l.trim().startsWith("uses:"));
    for (const line of actionLines) {
      const match = line.match(/uses:\s*[^@]+@([0-9a-fA-F]{40})/);
      expect(match, `Action should be pinned to 40-char SHA: ${line}`).not.toBeNull();
    }
  });

  describe("Gitleaks custom regex rules validation", () => {
    const configContent = readFileSync(gitleaksConfigPath, "utf-8");

    it("defines rule for SlipPay live API keys", () => {
      expect(configContent).toContain('id = "slippay-live-api-key"');
      const apiKeyRegex = new RegExp(["sk", "live", "[0-9a-zA-Z]{24,}"].join("_"));
      const syntheticKey = ["sk", "live"].join("_") + "_1234567890abcdef12345678";
      expect(apiKeyRegex.test(syntheticKey)).toBe(true);
      expect(apiKeyRegex.test(["sk", "test"].join("_") + "_1234567890abcdef12345678")).toBe(false);
    });

    it("defines rule for Stellar secret seeds (S...)", () => {
      expect(configContent).toContain('id = "stellar-secret-seed"');
      const stellarSeedRegex = /\bS[A-Z2-7]{55}\b/;
      const syntheticSeed = "S" + "A".repeat(55);
      expect(syntheticSeed.length).toBe(56);
      expect(stellarSeedRegex.test(syntheticSeed)).toBe(true);
      expect(stellarSeedRegex.test("G" + "A".repeat(55))).toBe(false);
    });

    it("defines rule for EVM / Base 64-character hex private keys", () => {
      expect(configContent).toContain('id = "evm-private-key"');
      const evmRegex = /\b(?:0x)?[0-9a-f]{64}\b/i;
      const syntheticHex = "0x" + "a".repeat(64);
      expect(evmRegex.test(syntheticHex)).toBe(true);
      expect(evmRegex.test("0x" + "a".repeat(32))).toBe(false);
    });

    it("defines allowlist for test fixtures and examples", () => {
      expect(configContent).toContain("[allowlist]");
      expect(configContent).toContain("ci-test-");
      expect(configContent).toContain("\\.test\\.");
    });
  });
});

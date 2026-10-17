import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Checkout Contract Deploy Script & Verification (Issue #308)", () => {
  const scriptPath = path.resolve(__dirname, "../../../contracts/checkout/deploy-testnet.sh");
  const docPath = path.resolve(__dirname, "../../../contracts/checkout/DEPLOYMENT.md");
  const gitignorePath = path.resolve(__dirname, "../../../.gitignore");

  it("contracts/checkout/deploy-testnet.sh exists and is executable shell script", () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("validates fee recipient address and basis points parameters", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");

    // Must check FEE_TO required
    expect(content).toContain('if [[ -z "$FEE_TO" ]]');

    // Must validate Base32 Stellar address format
    expect(content).toMatch(/FEE_TO.*~.*\[GC\]\[A-Z2-7\]\{55\}/);

    // Must bound FEE_BPS between 0 and 10,000
    expect(content).toContain("FEE_BPS > 10000");
  });

  it("performs post-deploy on-chain smoke verification for fee_bps and fee_to", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");

    // Must query live contract on-chain
    expect(content).toContain("stellar contract invoke");
    expect(content).toContain("fee_bps");
    expect(content).toContain("fee_to");

    // Must assert agreement
    expect(content).toContain('if [[ "$ONCHAIN_FEE_BPS" != "$FEE_BPS" ]]');
    expect(content).toContain('if [[ "$ONCHAIN_FEE_TO" != "$FEE_TO" ]]');
  });

  it("persists deployment metadata to an ignored env file", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content).toContain(".testnet-deploy.env");

    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    expect(gitignore).toContain("contracts/*/.testnet-deploy.env");
  });

  it("documents deploy script in DEPLOYMENT.md", () => {
    const doc = fs.readFileSync(docPath, "utf-8");
    expect(doc).toContain("deploy-testnet.sh");
    expect(doc).toContain("fee_to_address");
  });
});

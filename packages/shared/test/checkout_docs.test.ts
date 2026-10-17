import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Checkout Contract Documentation & Fee Semantics (Issue #309)", () => {
  const contractLibPath = path.resolve(__dirname, "../../../contracts/checkout/src/lib.rs");
  const deploymentDocPath = path.resolve(__dirname, "../../../contracts/checkout/DEPLOYMENT.md");

  it("contracts/checkout/src/lib.rs documents rounding, bounds, zero-net and links to docs/fees.md", () => {
    expect(fs.existsSync(contractLibPath)).toBe(true);
    const content = fs.readFileSync(contractLibPath, "utf-8");

    // Rate bounds
    expect(content).toContain("0..=10_000");
    expect(content).toContain("fee_bps");

    // Rounding direction
    expect(content).toMatch(/truncat(e|ing)|floor/i);
    expect(content).toMatch(/merchant/i);

    // Zero-net & zero-fee
    expect(content).toContain("Zero-Net");
    expect(content).toContain("Zero-Fee");

    // Atomicity
    expect(content).toContain("Atomicity & Revert Safety");

    // Link to docs/fees.md
    expect(content).toContain("docs/fees.md");
  });

  it("contracts/checkout/DEPLOYMENT.md contains the complete Fee Semantics & Invariants table", () => {
    expect(fs.existsSync(deploymentDocPath)).toBe(true);
    const doc = fs.readFileSync(deploymentDocPath, "utf-8");

    expect(doc).toContain("## Fee Semantics & Invariants");
    expect(doc).toContain("Rate Unit & Bounds");
    expect(doc).toContain("0..=10_000");
    expect(doc).toContain("Rounding Direction");
    expect(doc).toContain("Conservation Identity");
    expect(doc).toContain("Zero-Net Behaviour");
    expect(doc).toContain("Zero-Fee Behaviour");
    expect(doc).toContain("docs/fees.md");
  });
});

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Checkout Contract Symmetrical Transfer Guards (Issue #306)", () => {
  const contractLibPath = path.resolve(__dirname, "../../../contracts/checkout/src/lib.rs");
  const contractTestPath = path.resolve(__dirname, "../../../contracts/checkout/src/test.rs");

  it("contracts/checkout/src/lib.rs exists and is accessible", () => {
    expect(fs.existsSync(contractLibPath)).toBe(true);
  });

  it("guards both merchant net and fee legs with explicit > 0 checks", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");

    // Must check net > 0 before client.transfer to merchant
    expect(content).toMatch(/if net > 0\s*\{\s*client\.transfer\(&from,\s*&merchant,\s*&net\);\s*\}/);

    // Must check fee > 0 before client.transfer to fee_to
    expect(content).toMatch(/if fee > 0\s*\{\s*client\.transfer\(&from,\s*&fee_to,\s*&fee\);\s*\}/);
  });

  it("documents rationale for SEP-41 zero-amount transfer divergence", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");
    expect(content).toContain("SEP-41");
    expect(content).toMatch(/zero-amount transfers/i);
  });

  it("contracts/checkout/src/test.rs contains zero net and zero fee tests", () => {
    expect(fs.existsSync(contractTestPath)).toBe(true);
    const testContent = fs.readFileSync(contractTestPath, "utf-8");

    expect(testContent).toContain("test_configured_maximum_fee_bps_zero_net_skips_merchant_transfer");
    expect(testContent).toContain("test_configured_zero_fee_bps_does_not_transfer_fee");
  });
});

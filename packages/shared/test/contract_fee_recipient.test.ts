import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Checkout Contract Fee Recipient Guards (Issue #310)", () => {
  const contractLibPath = path.resolve(__dirname, "../../../contracts/checkout/src/lib.rs");
  const contractTestPath = path.resolve(__dirname, "../../../contracts/checkout/src/test.rs");

  it("contracts/checkout/src/lib.rs exists and is accessible", () => {
    expect(fs.existsSync(contractLibPath)).toBe(true);
  });

  it("rejects fee_to == env.current_contract_address() in constructor", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");
    expect(content).toMatch(/fee_to\s*==\s*env\.current_contract_address\(\)/);
  });

  it("rejects merchant == fee_to in pay function", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");
    expect(content).toMatch(/merchant\s*==\s*fee_to/);
  });

  it("contracts/checkout/src/test.rs contains explicit rejection tests for both guards", () => {
    expect(fs.existsSync(contractTestPath)).toBe(true);
    const testContent = fs.readFileSync(contractTestPath, "utf-8");

    expect(testContent).toContain("test_constructor_rejects_fee_to_as_contract_address");
    expect(testContent).toContain("test_pay_rejects_merchant_equal_to_fee_recipient");
    expect(testContent).toContain("test_normal_distinct_recipients_succeed");
  });
});

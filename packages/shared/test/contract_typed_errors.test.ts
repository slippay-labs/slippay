import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Checkout Contract Typed Errors & Storage Integrity (Issue #305)", () => {
  const contractLibPath = path.resolve(__dirname, "../../../contracts/checkout/src/lib.rs");
  const contractTestPath = path.resolve(__dirname, "../../../contracts/checkout/src/test.rs");

  it("contracts/checkout/src/lib.rs exists and is accessible", () => {
    expect(fs.existsSync(contractLibPath)).toBe(true);
  });

  it("contracts/checkout/src/lib.rs contains zero untyped unwrap() or expect() calls", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");
    const nonTestContent = content.split("#[cfg(test)]")[0];

    // Assert no bare .unwrap() or .expect(
    expect(nonTestContent).not.toMatch(/\.unwrap\(\)/);
    expect(nonTestContent).not.toMatch(/\.expect\(/);
  });

  it("fee_to and fee_bps view functions guard unconfigured storage with typed Error::BadConfig", () => {
    const content = fs.readFileSync(contractLibPath, "utf-8");

    // fee_to must use unwrap_or_else with BadConfig
    expect(content).toMatch(/pub fn fee_to\(env: Env\) -> Address[\s\S]*?DataKey::FeeTo[\s\S]*?unwrap_or_else\(\|\|\s*panic_with\(&env,\s*Error::BadConfig\)\)/);

    // fee_bps must use unwrap_or_else with BadConfig rather than unwrap_or(0)
    expect(content).toMatch(/pub fn fee_bps\(env: Env\) -> u32[\s\S]*?DataKey::FeeBps[\s\S]*?unwrap_or_else\(\|\|\s*panic_with\(&env,\s*Error::BadConfig\)\)/);
    expect(content).not.toMatch(/DataKey::FeeBps\)\.unwrap_or\(0\)/);
  });

  it("contracts/checkout/src/test.rs contains comprehensive unconfigured and lifecycle assertions", () => {
    expect(fs.existsSync(contractTestPath)).toBe(true);
    const testContent = fs.readFileSync(contractTestPath, "utf-8");

    expect(testContent).toContain("test_unconfigured_fee_to_returns_bad_config");
    expect(testContent).toContain("test_unconfigured_fee_bps_returns_bad_config");
    expect(testContent).toContain("test_unconfigured_pay_returns_bad_config");
    expect(testContent).toContain("soroban_sdk::Error::from(Error::BadConfig)");
    expect(testContent).toContain("test_configured_views_and_pay_flow");
  });
});

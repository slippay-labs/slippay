import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Checkout Contract Unconfigured State Guards (Issue #304)", () => {
  const contractPath = join(__dirname, "../../../contracts/checkout/src/lib.rs");
  const testPath = join(__dirname, "../../../contracts/checkout/src/test.rs");
  const contractCode = readFileSync(contractPath, "utf-8");
  const testCode = readFileSync(testPath, "utf-8");

  it("ensures fee_bps does not return a silent 0 fallback", () => {
    expect(contractCode).not.toMatch(/fee_bps[^{]*\{[^}]*\.unwrap_or\(0\)/);
  });

  it("ensures fee_to does not perform a bare unwrap", () => {
    expect(contractCode).not.toMatch(/fee_to[^{]*\{[^}]*\.unwrap\(\)/);
  });

  it("ensures fee_bps, fee_to, and pay all handle unconfigured storage via Error::BadConfig", () => {
    // Both fee_bps and fee_to must use Error::BadConfig
    expect(contractCode).toMatch(/fee_bps[^{]*\{[\s\S]*?Error::BadConfig/);
    expect(contractCode).toMatch(/fee_to[^{]*\{[\s\S]*?Error::BadConfig/);
    expect(contractCode).toMatch(/fn pay[^{]*\{[\s\S]*?Error::BadConfig/);
  });

  it("ensures unconfigured test coverage exists in test.rs", () => {
    expect(testCode).toContain("test_unconfigured_contract_views_fail_closed_with_bad_config");
    expect(testCode).toContain("test_configured_zero_fee_bps_returns_zero_and_distinguishes_from_unconfigured");
  });
});

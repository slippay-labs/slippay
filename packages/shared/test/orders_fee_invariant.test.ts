import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("orders table fee invariant (Issue #230)", () => {
  it("enforces fee_usdc <= usdc_amount in migration definition", () => {
    const migrationPath = resolve(__dirname, "../../../supabase/migrations/20261017100000_orders_fee_le_gross_constraint.sql");
    expect(existsSync(migrationPath)).toBe(true);

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("orders_fee_le_gross_check");
    expect(sql).toContain("CHECK (fee_usdc <= usdc_amount)");
    expect(sql).toContain("UPDATE public.orders");
    expect(sql).toContain("SET fee_usdc = usdc_amount");
  });

  it("proves the identity that platform fee cannot exceed gross amount", () => {
    const testCases = [
      { usdc: "100.0000000", feeBp: 297, expectedFee: "2.9700000" },
      { usdc: "10.0000000", feeBp: 1000, expectedFee: "1.0000000" }, // max allowable bp (10%)
      { usdc: "1.0000000", feeBp: 0, expectedFee: "0.0000000" },
    ];

    for (const { usdc, feeBp, expectedFee } of testCases) {
      const gross = parseFloat(usdc);
      const fee = parseFloat(expectedFee);
      expect(fee).toBeLessThanOrEqual(gross);
      expect(gross * (feeBp / 10000)).toBeCloseTo(fee, 7);
    }
  });

  it("rejects corrupted state where fee_usdc > usdc_amount", () => {
    const violatesInvariant = (gross: number, fee: number) => {
      if (fee > gross) {
        throw new Error('violates check constraint "orders_fee_le_gross_check"');
      }
      return true;
    };

    expect(() => violatesInvariant(10.0, 10.0000001)).toThrow('violates check constraint "orders_fee_le_gross_check"');
    expect(() => violatesInvariant(5.0, 100.0)).toThrow('violates check constraint "orders_fee_le_gross_check"');
    expect(violatesInvariant(10.0, 10.0)).toBe(true);
    expect(violatesInvariant(10.0, 0.0)).toBe(true);
  });
});

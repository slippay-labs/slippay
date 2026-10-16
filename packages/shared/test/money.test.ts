import { describe, it, expect } from "vitest";
import {
  decimalToStroops,
  stroopsToDecimal,
  aggregatePeriodTotals,
  STROOPS_PER_USDC,
} from "../src/money.ts";

describe("money utilities (BigInt stroop exact math)", () => {
  it("converts whole units and decimals to stroops correctly", () => {
    expect(decimalToStroops("1")).toBe(10_000_000n);
    expect(decimalToStroops("1.0000000")).toBe(10_000_000n);
    expect(decimalToStroops("10.5")).toBe(105_000_000n);
    expect(decimalToStroops("0.0000001")).toBe(1n);
    expect(decimalToStroops("0")).toBe(0n);
    expect(decimalToStroops("")).toBe(0n);
    expect(decimalToStroops(null)).toBe(0n);
    expect(decimalToStroops(undefined)).toBe(0n);
    expect(decimalToStroops("-1.0000001")).toBe(-10_000_001n);
  });

  it("converts stroops to 7-decimal string representation", () => {
    expect(stroopsToDecimal(10_000_000n)).toBe("1.0000000");
    expect(stroopsToDecimal(1n)).toBe("0.0000001");
    expect(stroopsToDecimal(0n)).toBe("0.0000000");
    expect(stroopsToDecimal(-1n)).toBe("-0.0000001");
    expect(stroopsToDecimal(105_000_000n)).toBe("10.5000000");
  });

  it("handles awkward fractional values exactly without loss", () => {
    const awkward = "123.4567891";
    const stroops = decimalToStroops(awkward);
    expect(stroops).toBe(1_234_567_891n);
    expect(stroopsToDecimal(stroops)).toBe(awkward);
  });

  it("aggregates period totals with 10,000 awkward rows and asserts zero drift", () => {
    // 10,000 rows with awkward fractions (e.g. 0.0000001 USDC, 0.0002970 USDC fee)
    // In IEEE-754 float: 0.0000001 * 10,000 accumulates binary rounding error.
    const N = 10_000;
    const amountStr = "0.0000001";
    const feeStr = "0.0000001";

    const fixture: Array<{ usdc_amount: string; fee_usdc: string }> = [];
    let expectedGrossStroops = 0n;
    let expectedFeeStroops = 0n;

    for (let i = 0; i < N; i++) {
      // Alternate with slightly different awkward values to test variety
      const amount = i % 2 === 0 ? "1.0000001" : "0.0000001";
      const fee = i % 2 === 0 ? "0.0002970" : "0.0000001";
      fixture.push({ usdc_amount: amount, fee_usdc: fee });

      expectedGrossStroops += decimalToStroops(amount);
      expectedFeeStroops += decimalToStroops(fee);
    }

    const totals = aggregatePeriodTotals(fixture);

    // 1. Assert exact match with manual arithmetic integer sum
    expect(totals.gross_stroops).toBe(expectedGrossStroops);
    expect(totals.fee_stroops).toBe(expectedFeeStroops);
    expect(totals.net_stroops).toBe(expectedGrossStroops - expectedFeeStroops);

    // 2. The difference for a 10,000-row fixture is asserted to be exactly zero
    const difference = totals.gross_stroops - expectedGrossStroops;
    expect(difference).toBe(0n);

    // 3. Exact formatting check
    expect(totals.gross_usdc).toBe(stroopsToDecimal(expectedGrossStroops));
    expect(totals.fee_usdc_total).toBe(stroopsToDecimal(expectedFeeStroops));
    expect(totals.net_usdc_total).toBe(stroopsToDecimal(expectedGrossStroops - expectedFeeStroops));

    // 4. Assert invariant: gross_stroops - fee_stroops === net_stroops
    expect(totals.gross_stroops - totals.fee_stroops).toBe(totals.net_stroops);
  });
});

import { describe, it, expect } from "vitest";
import {
  aggregatePeriodTotals,
  decimalToStroops,
  stroopsToDecimal,
  sumStroops,
} from "../src/index.ts";

/** Independent exact parse used to check the production helper. */
function expectedStroops(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [intPart, fracPart = ""] = unsigned.split(".");
  const stroops = BigInt(intPart!) * 10_000_000n + BigInt(fracPart.padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

describe("exact money arithmetic", () => {
  it("parses and formats decimal amounts exactly", () => {
    expect(decimalToStroops("1.2345678")).toBe(12_345_678n);
    expect(stroopsToDecimal(12_345_678n)).toBe("1.2345678");
    expect(stroopsToDecimal(0n)).toBe("0.0000000");
    expect(decimalToStroops("-0.0000001")).toBe(-1n);
    expect(stroopsToDecimal(-1n)).toBe("-0.0000001");
  });

  it("rejects malformed amounts and more than 7 fractional digits", () => {
    expect(() => decimalToStroops("1.23456789")).toThrow();
    expect(() => decimalToStroops("1,5")).toThrow();
    expect(() => decimalToStroops("")).toThrow();
    expect(() => decimalToStroops("NaN")).toThrow();
  });

  it("sums awkward fractions exactly", () => {
    const values = ["0.1000001", "0.2000002", "0.3000003", "1.7241379", "0.0168965"];
    const expected = values.reduce((total, value) => total + expectedStroops(value), 0n);
    expect(sumStroops(values)).toBe(expected);
  });

  it("produces a zero difference on a 10,000-row fixture", () => {
    const awkward = [
      "0.1000001",
      "0.2000002",
      "0.3000003",
      "1.7241379",
      "0.0168965",
      "999.9999999",
      "0.0000001",
    ];
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      usdc_amount: awkward[i % awkward.length]!,
      fee_usdc: awkward[(i * 3 + 1) % awkward.length]!,
    }));

    const expectedGross = rows.reduce((total, row) => total + expectedStroops(row.usdc_amount), 0n);
    const expectedFee = rows.reduce((total, row) => total + expectedStroops(row.fee_usdc), 0n);
    const totals = aggregatePeriodTotals(rows);

    expect(totals.grossStroops).toBe(expectedGross);
    expect(totals.feeStroops).toBe(expectedFee);
    expect(totals.netStroops).toBe(expectedGross - expectedFee);
    // The invoice identity holds exactly, with no floating-point residue.
    expect(totals.grossStroops - totals.feeStroops - totals.netStroops).toBe(0n);
  });
});

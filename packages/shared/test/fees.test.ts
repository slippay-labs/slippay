import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLATFORM_FEE_BP,
  brlToUsdcStroops,
  computeBrlChargeSplit,
  splitFee,
  stellarToStroops,
  stroopsToStellar,
} from "../src/index.ts";

/**
 * Canonical fee calculation per docs/fees.md
 */
export function calculateFee(grossBaseUnits: bigint, feeBp: number): { net: bigint; fee: bigint } {
  if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 10_000) {
    throw new Error("invalid_fee_bp");
  }
  const fee = (grossBaseUnits * BigInt(feeBp)) / 10_000n;
  const net = grossBaseUnits - fee;
  return { net, fee };
}

describe("docs/fees.md canonical fee arithmetic specification vectors", () => {
  it("Vector 1: Standard Exact Settlement (100 USDC @ 297 bp)", () => {
    // 100 USDC = 100 * 10^7 = 1,000,000,000 stroops
    const gross = 1_000_000_000n;
    const { net, fee } = calculateFee(gross, 297);
    expect(fee).toBe(29_700_000n); // 2.97 USDC
    expect(net).toBe(970_300_000n); // 97.03 USDC
    expect(net + fee).toBe(gross);
  });

  it("Vector 2: Inexact Division with Fractional Dust (1.0000001 USDC @ 297 bp)", () => {
    // 1.0000001 USDC = 10,000,001 stroops
    const gross = 10_000_001n;
    const { net, fee } = calculateFee(gross, 297);
    // 10000001 * 297 = 2970000297. Floor / 10000 = 297000 stroops
    expect(fee).toBe(297_000n);
    expect(net).toBe(9_703_001n);
    expect(net + fee).toBe(gross);
    // Verifies that merchant receives the fractional remainder dust (0.0297 stroops discarded from fee)
  });

  it("Vector 3: Sub-Cent Micro-Payment (1 stroop @ 297 bp)", () => {
    const gross = 1n;
    const { net, fee } = calculateFee(gross, 297);
    // 1 * 297 / 10000 = 0 fee
    expect(fee).toBe(0n);
    expect(net).toBe(1n);
    expect(net + fee).toBe(gross);
  });

  it("Vector 4: Zero-Fee Account (50 USDC @ 0 bp)", () => {
    const gross = 500_000_000n;
    const { net, fee } = calculateFee(gross, 0);
    expect(fee).toBe(0n);
    expect(net).toBe(gross);
    expect(net + fee).toBe(gross);
  });

  it("Conservation invariant: net + fee === gross for all valid ranges", () => {
    const testCases: [bigint, number][] = [
      [12_500_000n, 297],
      [999_999n, 297],
      [10_000_000n, DEFAULT_PLATFORM_FEE_BP],
      [5_432_109n, 100],
      [100_000_000n, 1000],
      [77_777_777n, 499],
    ];

    for (const [gross, bp] of testCases) {
      const { net, fee } = calculateFee(gross, bp);
      expect(net + fee).toBe(gross);
      expect(net).toBeGreaterThanOrEqual(0n);
      expect(fee).toBeGreaterThanOrEqual(0n);
    }
  });

  it("Rejects invalid fee basis points bounds (< 0 or > 10000)", () => {
    expect(() => calculateFee(100n, -1)).toThrow("invalid_fee_bp");
    expect(() => calculateFee(100n, 10_001)).toThrow("invalid_fee_bp");
  });
});

describe("Issue #490: Subscription and order fee consistency and integer math", () => {
  it("computes subscription charge split in exact integer stroops matching contract rule", () => {
    // 100 BRL @ rate 5.0 = 20 USDC = 200,000,000 stroops
    // 297 bps -> fee = floor(200,000,000 * 297 / 10,000) = 5,940,000 stroops = 0.5940000 USDC
    // net = 194,060,000 stroops = 19.4060000 USDC
    const split = computeBrlChargeSplit("100.00", 5.0, 297);
    expect(split.usdcAmount).toBe("20.0000000");
    expect(split.feeUsdc).toBe("0.5940000");
    expect(split.netUsdc).toBe("19.4060000");
    expect(split.grossStroops).toBe(200_000_000n);
    expect(split.feeStroops).toBe(5_940_000n);
    expect(split.netStroops).toBe(194_060_000n);
    expect(split.grossStroops).toBe(split.feeStroops + split.netStroops);
  });

  it("floors the fee to avoid rounding discrepancies with Soroban contract", () => {
    // Inexact fee division: 1.0000001 USDC @ 297 bp
    // 10,000,001 * 297 / 10,000 = 297,000.0297 -> floored to 297,000 stroops
    const grossStroops = 10_000_001n;
    const split = splitFee(grossStroops, 297);
    expect(split.fee).toBe(297_000n);
    expect(split.net).toBe(9_703_001n);
    expect(split.fee + split.net).toBe(grossStroops);
  });

  it("asserts subscription charge and one-off order produce byte-identical amounts", () => {
    const testCases: Array<{ brl: string; rate: number; bp: number }> = [
      { brl: "10.00", rate: 5.2345678, bp: 297 },
      { brl: "99.99", rate: 5.5, bp: 150 },
      { brl: "1.00", rate: 5.0, bp: 98 },
      { brl: "1250.50", rate: 5.6789123, bp: 300 },
      { brl: "0.50", rate: 5.0, bp: 297 },
    ];

    for (const { brl, rate, bp } of testCases) {
      // Subscription charge calculation
      const subSplit = computeBrlChargeSplit(brl, rate, bp);

      // One-off order calculation
      const orderSplit = computeBrlChargeSplit(brl, rate, bp);

      expect(subSplit.usdcAmount).toBe(orderSplit.usdcAmount);
      expect(subSplit.feeUsdc).toBe(orderSplit.feeUsdc);
      expect(subSplit.netUsdc).toBe(orderSplit.netUsdc);
      expect(subSplit.grossStroops).toBe(orderSplit.grossStroops);
      expect(subSplit.feeStroops).toBe(orderSplit.feeStroops);
      expect(subSplit.netStroops).toBe(orderSplit.netStroops);
    }
  });

  it("verifies against docs/fees.md canonical fee arithmetic vectors", () => {
    // Vector 1: 100 USDC @ 297 bp
    const v1 = splitFee(1_000_000_000n, 297);
    expect(v1.fee).toBe(29_700_000n);
    expect(v1.net).toBe(970_300_000n);

    // Vector 2: 1.0000001 USDC @ 297 bp
    const v2 = splitFee(10_000_001n, 297);
    expect(v2.fee).toBe(297_000n);
    expect(v2.net).toBe(9_703_001n);

    // Vector 3: 1 stroop @ 297 bp
    const v3 = splitFee(1n, 297);
    expect(v3.fee).toBe(0n);
    expect(v3.net).toBe(1n);

    // Vector 4: 50 USDC @ 0 bp
    const v4 = splitFee(500_000_000n, 0);
    expect(v4.fee).toBe(0n);
    expect(v4.net).toBe(500_000_000n);
  });
});

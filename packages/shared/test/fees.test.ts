import { describe, it, expect } from "vitest";
import { calculateFeeSplit, FEE_VECTORS, DEFAULT_PLATFORM_FEE_BP } from "../src/index.ts";

describe("Shared Fee Vectors · Canonical Reference Suite (Issue #237)", () => {
  it("exports valid canonical DEFAULT_PLATFORM_FEE_BP as 297", () => {
    expect(DEFAULT_PLATFORM_FEE_BP).toBe(297);
  });

  FEE_VECTORS.forEach((vec) => {
    it(`[Vector: ${vec.id}] calculateFeeSplit matches expected fee and net stroops`, () => {
      const amountStroops = BigInt(vec.amount_stroops);
      const expectedFeeStroops = BigInt(vec.expected_fee_stroops);
      const expectedNetStroops = BigInt(vec.expected_net_stroops);

      const split = calculateFeeSplit(amountStroops, vec.fee_bps);

      expect(split.feeStroops, `feeStroops for ${vec.id}`).toBe(expectedFeeStroops);
      expect(split.netStroops, `netStroops for ${vec.id}`).toBe(expectedNetStroops);

      // Invariant: net + fee === amount
      expect(split.netStroops + split.feeStroops).toBe(amountStroops);
    });
  });

  it("rejects out-of-bounds fee basis points", () => {
    expect(() => calculateFeeSplit(10_000_000n, -1)).toThrow("Invalid fee basis points");
    expect(() => calculateFeeSplit(10_000_000n, 10_001)).toThrow("Invalid fee basis points");
  });

  it("fails if rounding direction is changed to ceiling or nearest", () => {
    // Under 1 bp on 19999 stroops, true fee is 1.9999 stroops.
    // Floor division must be exactly 1.
    const split = calculateFeeSplit(19999n, 1);
    expect(split.feeStroops).toBe(1n);
    expect(split.netStroops).toBe(19998n);

    // If a buggy implementation used Math.round (nearest), fee would be 2n.
    // If a buggy implementation used Math.ceil (ceiling), fee would be 2n.
    expect(split.feeStroops).not.toBe(2n);
  });
});

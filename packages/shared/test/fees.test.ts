import { describe, it, expect } from "vitest";
import {
  calculateFeeSplit,
  calculateFeeSplitStellar,
  stellarToStroops,
  stroopsToStellar,
} from "../src/fees.ts";

describe("fees · canonical integer stroop floor arithmetic (Issue #219)", () => {
  it("floors the fee where flooring and float rounding differ", () => {
    // Vector 1: gross = 1.0000190 USDC (10,000,190 stroops), feeBp = 297 (2.97%)
    // Exact float calculation: 1.0000190 * 297 / 10000 = 0.0297005643
    // Floating point .toFixed(7) would ROUND UP to "0.0297006"
    // Floor division on chain: 10_000_190 * 297 / 10_000 = 297_005 stroops = "0.0297005"
    const gross1 = "1.0000190";
    const bp1 = 297;
    const split1 = calculateFeeSplitStellar(gross1, bp1);

    expect(split1.feeStellar).toBe("0.0297005");
    expect(split1.netStellar).toBe("0.9703185");
    expect(split1.feeStroops).toBe(297_005n);
    expect(split1.netStroops).toBe(9_703_185n);

    // Invariant: net + fee === gross by construction
    expect(split1.feeStroops + split1.netStroops).toBe(10_000_190n);
    expect(
      stellarToStroops(split1.feeStellar) + stellarToStroops(split1.netStellar)
    ).toBe(stellarToStroops(gross1));

    // Assert that float .toFixed(7) would have rounded UP (demonstrating the bug #219 fixes)
    const floatFee1 = (parseFloat(gross1) * bp1 / 10_000).toFixed(7);
    expect(floatFee1).toBe("0.0297006");
    expect(split1.feeStellar).not.toBe(floatFee1);
  });

  it("floors sub-stroop micro-amounts to zero fee where rounding would charge 1 stroop", () => {
    // Vector 2: gross = 0.0000019 USDC (19 stroops), feeBp = 297
    // Exact fee: 0.0000019 * 297 / 10000 = 0.00000005643
    // .toFixed(7) rounds UP to "0.0000001" (1 stroop)
    // Floor integer division: 19 * 297 / 10000 = 0 stroops ("0.0000000")
    const gross2 = "0.0000019";
    const bp2 = 297;
    const split2 = calculateFeeSplitStellar(gross2, bp2);

    expect(split2.feeStellar).toBe("0.0000000");
    expect(split2.netStellar).toBe("0.0000019");
    expect(split2.feeStroops).toBe(0n);
    expect(split2.netStroops).toBe(19n);

    const floatFee2 = (parseFloat(gross2) * bp2 / 10_000).toFixed(7);
    expect(floatFee2).toBe("0.0000001");
    expect(split2.feeStellar).not.toBe(floatFee2);
  });

  it("matches contracts/checkout/src/lib.rs line 59 and listener matcher exactly", () => {
    // Rust contract: let fee: i128 = amount * (fee_bps as i128) / 10_000;
    //                let net: i128 = amount - fee;
    const testCases = [
      { amount: 10_000_000n, bp: 297, expectedFee: 297_000n, expectedNet: 9_703_000n },
      { amount: 10_000_001n, bp: 25, expectedFee: 25_000n, expectedNet: 9_975_001n },
      { amount: 1n, bp: 297, expectedFee: 0n, expectedNet: 1n },
      { amount: 9_999n, bp: 297, expectedFee: 296n, expectedNet: 9_703n },
      { amount: 100_000_000_000n, bp: 1000, expectedFee: 10_000_000_000n, expectedNet: 90_000_000_000n },
      { amount: 50_000_000n, bp: 0, expectedFee: 0n, expectedNet: 50_000_000n },
      { amount: 50_000_000n, bp: 10_000, expectedFee: 50_000_000n, expectedNet: 0n },
    ];

    for (const tc of testCases) {
      const split = calculateFeeSplit(tc.amount, tc.bp);
      expect(split.feeStroops).toBe(tc.expectedFee);
      expect(split.netStroops).toBe(tc.expectedNet);
      expect(split.feeStroops + split.netStroops).toBe(tc.amount);
    }
  });

  it("rejects invalid fee basis points and malformed amounts", () => {
    expect(() => calculateFeeSplit(100n, -1)).toThrow(/Invalid fee basis points/);
    expect(() => calculateFeeSplit(100n, 10_001)).toThrow(/Invalid fee basis points/);
    expect(() => calculateFeeSplit(100n, 2.5)).toThrow(/Invalid fee basis points/);
    expect(() => calculateFeeSplit(-100n, 100)).toThrow(/Invalid amount stroops/);

    expect(() => stellarToStroops("invalid")).toThrow(/bad_amount/);
    expect(() => stellarToStroops("-1.00")).toThrow(/bad_amount/);
    expect(() => stellarToStroops("1.12345678")).toThrow(/bad_amount/);
  });
});

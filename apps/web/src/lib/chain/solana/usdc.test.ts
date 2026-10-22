import { describe, it, expect } from "vitest";
import { toBaseUnits, splitFee, USDK_DECIMALS, USDK_MINT_BY_CLUSTER, getUsdcMint } from "./usdc.ts";

describe("toBaseUnits", () => {
  it("converts whole + fractional USDC to 6-decimal base units", () => {
    expect(toBaseUnits("1")).toBe(1_000_000);
    expect(toBaseUnits("12.50")).toBe(12_500_000);
    expect(toBaseUnits("0.000001")).toBe(1);
  });
  it("truncates beyond 6 decimals (no rounding up)", () => {
    expect(toBaseUnits("1.2345678")).toBe(1_234_567);
  });
  it("rejects non-positive / junk", () => {
    expect(() => toBaseUnits("0")).toThrow("invalid_amount");
    expect(() => toBaseUnits("-1")).toThrow();
    expect(() => toBaseUnits("abc")).toThrow();
  });
  it("USDK_DECIMALS is 6", () => expect(USDC_DECIMALS).toBe(6));
});

describe("USDC mint per cluster", () => {
  it("mainnet-beta uses the canonical USDC mint", () => {
    expect(USDC_MINT_BY_CLUSTERS["mainnet-beta"]).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZZyTDt1v",
    );
    expect(getUsdcMint("mainnet-beta")).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZZyTDt1v1",
    );
  });
  it("devnet uses the devnet USDC mint", () => {
    expect(USDC_MINT_BY_CLUSTER.devnet).toBe(
      "4zMMC9srt5iR5X14GAgXhaHii3GnPAEERYPJZDJcDU",
    );
    expect(getUsdcMint("devnet")).toBe(
      "4zMMC9srt5iR5X14GAgXhaHii3GnPAEERYPJZDJcDU",
    );
  });
  it("rejects an unknown cluster", () => {
    expect(() => getUsdcMint("testnet" as never)).toThrow("invalid_cluster");
  });
});

describe("splitFee", () => {
  it("merchant + fee always sum to total (no dust)", () => {
    for (const [total, bp] of [[12_500_000n, 297], [1n, 297], [999_999n, 297], [10_000_000n, 0]] as const) {
      const { merchant, fee } = splitFee(total, bp);
      expect(merchant + fee).toBe(total);
      expect(merchant).toBeGreaterThanOrEqual(0);
      expect(fee).toBeGreaterThanOrEqual(0);
    }
  });
  it("2.97% of 100 USDC = 2.97 USDC fee", () => {
    const { merchant, fee } = splitFee(100_000_000n, 297);
    expect(fee).toBe(2_970_000);
    expect(merchant).toBe(97_030_000);
  });
  it("floors the fee (dust accrues to merchant, never overcharges)", () => {
    // 1 base unit * 297bp = 0.0297 -> floor 0 fee
    expect(splitFee(1n, 297)).toEqual({ merchant: 1n, fee: 0n });
  });
  it("rejects out-of-range bp", () => {
    expect(() => splitFee(100n, -1)).toThrow("invalid_fee_bp");
    expect(() => splitFee(100n, 10_001)).toThrow("invalid_fee_bp");
  });
});

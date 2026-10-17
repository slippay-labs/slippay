import { describe, it, expect } from "vitest";
import {
  calculateFeeSplit,
  calculateFeeSplitStellar,
  stellarToStroops,
  stroopsToStellar,
  FEE_VECTORS,
} from "../src/fees.ts";
import { matchPaymentToOrder } from "../../../apps/listener/src/matcher.ts";
import { splitFee as solanaSplitFee } from "../../../apps/web/src/lib/chain/solana/usdc.ts";

describe("Cross-layer fee identity and on-chain parity suite (Issue #221)", () => {
  it("proves exact mathematical agreement across contract, edge, listener, and Solana implementations", () => {
    expect(FEE_VECTORS.length).toBeGreaterThanOrEqual(14);

    for (const vec of FEE_VECTORS) {
      const amountStroops = BigInt(vec.amount_stroops);
      const feeBp = vec.fee_bps;
      const expectedFeeStroops = BigInt(vec.expected_fee_stroops);
      const expectedNetStroops = BigInt(vec.expected_net_stroops);

      // 1. Contract simulation (contracts/checkout/src/lib.rs lines 59-60)
      //    let fee: i128 = amount * (fee_bps as i128) / 10_000;
      //    let net: i128 = amount - fee;
      const contractFee = (amountStroops * BigInt(feeBp)) / 10_000n;
      const contractNet = amountStroops - contractFee;

      // 2. Edge reference implementation (@slippay/shared calculateFeeSplit & calculateFeeSplitStellar)
      const edgeSplit = calculateFeeSplit(amountStroops, feeBp);
      const edgeStellar = calculateFeeSplitStellar(vec.amount_stellar, feeBp);

      // 3. Listener matcher implementation (apps/listener/src/matcher.ts)
      const order = {
        id: `ord_${vec.id}`,
        memo: "ab".repeat(32),
        usdc_amount: vec.amount_stellar,
        merchant_stellar_address: "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ",
        platform_fee_bp: feeBp,
      };

      // Exact net payment event
      const exactEvent = {
        memo_type: "hash",
        memo_b64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
        successful: true,
        to: order.merchant_stellar_address,
        amount: vec.expected_net_stellar,
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        hash: "tx_hash_1",
      };
      const matchResult = matchPaymentToOrder(exactEvent, order, "TESTNET");

      // 4. Solana client integer rule (apps/web/src/lib/chain/solana/usdc.ts splitFee)
      const solanaSplit = solanaSplitFee(amountStroops, feeBp);

      // --- Cross-Layer Assertions ---
      // A. Contract matches expected vector
      expect(contractFee).toBe(expectedFeeStroops);
      expect(contractNet).toBe(expectedNetStroops);

      // B. Edge matches contract
      expect(edgeSplit.feeStroops).toBe(contractFee);
      expect(edgeSplit.netStroops).toBe(contractNet);
      expect(edgeStellar.feeStroops).toBe(contractFee);
      expect(edgeStellar.netStroops).toBe(contractNet);
      expect(edgeStellar.feeStellar).toBe(vec.expected_fee_stellar);
      expect(edgeStellar.netStellar).toBe(vec.expected_net_stellar);

      // C. Listener acknowledges exact expected net as paid for operational fee rates (< 10000 bps)
      if (feeBp < 10_000) {
        expect(matchResult.outcome).toBe("paid");
      } else {
        expect(matchResult.outcome).toBe("ignore");
      }


      // D. Solana client integer rule matches contract and edge
      expect(solanaSplit.fee).toBe(contractFee);
      expect(solanaSplit.merchant).toBe(contractNet);

      // E. Conservation Invariant: net + fee === amount holds identically across all four
      expect(contractNet + contractFee).toBe(amountStroops);
      expect(edgeSplit.netStroops + edgeSplit.feeStroops).toBe(amountStroops);
      expect(solanaSplit.merchant + solanaSplit.fee).toBe(amountStroops);
      expect(
        stellarToStroops(edgeStellar.netStellar) + stellarToStroops(edgeStellar.feeStellar)
      ).toBe(stellarToStroops(vec.amount_stellar));
    }
  });

  it("covers required boundary edge vectors specified in Issue #221", () => {
    const ids = FEE_VECTORS.map((v) => v.id);

    // 1. Amount of one stroop
    expect(ids).toContain("one_stroop_bps_default");
    const oneStroop = FEE_VECTORS.find((v) => v.id === "one_stroop_bps_default")!;
    expect(oneStroop.amount_stroops).toBe("1");
    expect(oneStroop.expected_fee_stroops).toBe("0");
    expect(oneStroop.expected_net_stroops).toBe("1");

    // 2. Fee is exactly zero
    expect(ids).toContain("bps_zero");
    const zeroFee = FEE_VECTORS.find((v) => v.id === "bps_zero")!;
    expect(zeroFee.expected_fee_stroops).toBe("0");

    // 3. Fee is exactly one stroop
    expect(ids).toContain("exact_one_stroop_fee");
    const oneStroopFee = FEE_VECTORS.find((v) => v.id === "exact_one_stroop_fee")!;
    expect(oneStroopFee.expected_fee_stroops).toBe("1");

    // 4. Bps of 0
    expect(zeroFee.fee_bps).toBe(0);

    // 5. Bps of the maximum (1000 merchant cap and 10000 protocol max)
    expect(ids).toContain("bps_contract_cap_1000");
    expect(ids).toContain("one_stroop_bps_max_10000");

    // 6. Largest permitted Stellar int64 amount
    expect(ids).toContain("max_stellar_amount");
    const maxAmount = FEE_VECTORS.find((v) => v.id === "max_stellar_amount")!;
    expect(maxAmount.amount_stroops).toBe("9223372036854775807");
  });

  it("fails if any implementation alters the floor rounding direction", () => {
    // Vector "awkward_fraction_float_discrepancy": 1.0000190 with 297 bps
    // Exact float calculation: 1.0000190 * 297 / 10000 = 0.0297005643
    // Floored fee is 297005 stroops ("0.0297005")
    // Float rounding produces "0.0297006" (297006 stroops)
    const vec = FEE_VECTORS.find((v) => v.id === "awkward_fraction_float_discrepancy")!;
    const correctFee = calculateFeeSplit(BigInt(vec.amount_stroops), vec.fee_bps).feeStroops;
    expect(correctFee).toBe(297_005n);

    // Alternative ceiling rounding:
    const ceilFee = (BigInt(vec.amount_stroops) * BigInt(vec.fee_bps) + 9999n) / 10_000n;
    expect(ceilFee).toBe(297_006n);
    expect(ceilFee).not.toBe(correctFee);

    // Alternative float toFixed(7) rounding:
    const floatFeeStellar = (parseFloat(vec.amount_stellar) * vec.fee_bps / 10_000).toFixed(7);
    expect(floatFeeStellar).toBe("0.0297006");
    expect(stroopsToStellar(correctFee)).not.toBe(floatFeeStellar);
  });
});

import { describe, it, expect } from "vitest";
import { matchPaymentToOrder, type StellarPaymentEvent, stellarToStroops, stroopsToStellar } from "../src/matcher.js";
import feeVectors from "../../../packages/shared/src/vectors/fee_vectors.json";

describe("Shared Fee Vectors · Listener Matcher Layer (Issue #237)", () => {
  const MERCHANT_ACCOUNT = "GA".padEnd(56, "M");
  const ORDER_MEMO = "00".repeat(32);

  feeVectors.forEach((vec) => {
    it(`[Vector: ${vec.id}] asserts fee split and net expectation matches vector exactly`, () => {
      const order = {
        id: `ord-${vec.id}`,
        merchant_id: "m-test",
        memo: ORDER_MEMO,
        usdc_amount: vec.amount_stellar,
        merchant_stellar_address: MERCHANT_ACCOUNT,
        platform_fee_bp: vec.fee_bps,
      };

      // 1. Pay exactly the expected net merchant share -> should be "paid"
      const exactNetEvent: StellarPaymentEvent = {
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        to: MERCHANT_ACCOUNT,
        amount: vec.expected_net_stellar,
        hash: `hash-exact-${vec.id}`,
        memo_type: "hash",
        memo_b64: Buffer.from(ORDER_MEMO, "hex").toString("base64"),
        successful: true,
      };

      const exactOutcome = matchPaymentToOrder(exactNetEvent, order, "TESTNET");
      expect(exactOutcome.outcome, `Expected net payment ${vec.expected_net_stellar} to be paid for ${vec.id}`).toBe("paid");

      // 2. If expected net > 0, paying 1 stroop less should be strictly "underpaid"
      const netStroops = BigInt(vec.expected_net_stroops);
      if (netStroops > 0n) {
        const underpaidStroops = netStroops - 1n;
        const underpaidStellar = stroopsToStellar(underpaidStroops);
        const underpaidEvent: StellarPaymentEvent = {
          ...exactNetEvent,
          amount: underpaidStellar,
          hash: `hash-under-${vec.id}`,
        };

        const underOutcome = matchPaymentToOrder(underpaidEvent, order, "TESTNET");
        expect(underOutcome.outcome).toBe("underpaid");
        if (underOutcome.outcome === "underpaid") {
          expect(underOutcome.expected).toBe(vec.expected_net_stellar);
          expect(underOutcome.received).toBe(underpaidStellar);
        }
      }

      // 3. Mathematical stroop identity assertion
      const totalStroops = stellarToStroops(vec.amount_stellar);
      const expectedFeeStroops = BigInt(vec.expected_fee_stroops);
      const expectedNetStroops = BigInt(vec.expected_net_stroops);
      expect(expectedFeeStroops + expectedNetStroops).toBe(totalStroops);
    });
  });
});

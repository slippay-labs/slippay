import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchPaymentToOrder, stellarToStroops, stroopsToStellar, type StellarPaymentEvent } from "../src/matcher.js";

interface FeeVector {
  name: string;
  amount_stroops: string;
  amount: string;
  fee_bp: number;
  fee_stroops: string;
  fee: string;
  net_stroops: string;
  net: string;
}

interface FeeVectorFile {
  description: string;
  max_amount_stroops: string;
  vectors: FeeVector[];
}

const vectorPath = resolve(__dirname, "../../../suprabase/functions/api/test/fee-vectors.json");
const file = JSON.parse(readFileSync(vectorPath, "utf-8")) as FeeVectorFile;

const merchant = "G" + "M".repeat(55);
const issuer = "GBBD47IF6LWK7P7PDEVMSCWR7DPWUV3NY3DTQEVFL4NAT4AQH3ZZLFLA5";

function eventFor(vector: FeeVector): StellarPaymentEvent {
  return {
    memo_type: "hash",
    memo_b64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
    successful: true,
    asset_code: "USDC",
    asset_issuer: issuer,
    to: merchant,
    amount: vector.net,
    hash: "txhash",
  };
}

describe("shared fee vectors (listener matcher)", () => {
  it("has vectors and covers required bp boundaries", () => {
    expect(file.vectors.length).toBeGreaterThan(0);
    const bps = new Set(file.vectors.map((v) => v.fee_bp));
    for (const required of [0, 1, 297, 1000]) {
      expect(bps.has(required)).toBe(true);
    }
  });

  it("max_amount_stroops matches the largest vector amount", () => {
    const max = file.vectors
      .map((v) => BigInt(v.amount_stroops))
      .reduce((a, b) => (a > b ? a : b));
    expect(max.toString()).toBe(file.max_amount_stroops);
  });

  it("every vector round-trips amount and net through stroop conversion", () => {
    for (const v of file.vectors) {
      expect(stellarToStroops(v.amount).toString()).toBe(v.amount_stroops);
      expect(stroopsToStellar(BigInt(v.net_stroops))).toBe(v.net);
    }
  });

  it("matcher accepts exact net as paid", () => {
    for (const v of file.vectors) {
      const order = {
        id: "ord-1",
        memo: "ab".repeat(32),
        usdc_amount: v.amount,
        merchant_stellar_address: merchant,
        platform_fee_bp: v.fee_bp,
      };
      expect(matchPaymentToOrder(eventFor(v), order, "TESTNET")).toEqual({ outcome: "paid" });
    }
  });

  it("matcher rejects 1 stroop below net as underpaid", () => {
    for (const v of file.vectors) {
      const net = BigInt(v.net_stroops);
      if (net < 1n) continue;
      const order = {
        id: "ord-1",
        memo: "ab".repeat(32),
        usdc_amount: v.amount,
        merchant_stellar_address: merchant,
        platform_fee_bp: v.fee_bp,
      };
      const e = { ...eventFor(v), amount: stroopsToStellar(net - 1n) };
      const result = matchPaymentToOrder(e, order, "TESTNET");
      expect(result.outcome).toBe("underpaid");
    }
  });

  it("rounding direction is floor: fee never rounds up", () => {
    for (const v of file.vectors) {
      const amount = BigInt(v.amount_stroops);
      const fee = BigInt(v.fee_stroops);
      const net = BigInt(v.net_stroops);
      expect(fee + net).toBe(amount);
      expect(fee).toBe((amount * BigInt(v.fee_bp)) / 10000n);
    }
  });
});

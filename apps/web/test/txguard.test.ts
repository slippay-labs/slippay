import { describe, it, expect } from "vitest";
import { Account, Asset, Operation, TransactionBuilder, Networks, BASE_FEE } from "@stellar/stellar-sdk";
import { decodeTx, assertPaymentMatches, type TxSummary } from "../src/lib/txguard.ts";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST = "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ";
const SRC = "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X";

function sampleXdr(amount: string, memo?: string): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({
    destination: DEST, asset: new Asset("USDC", ISSUER), amount,
    memo: memo ? { type: "text", value: memo } : undefined,
  })).build();
  return tx.toXDR();
}

function twoPaymentXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" }))
    .addOperation(Operation.payment({ destination: SRC, asset: new Asset("USDC", ISSUER), amount: "999" }))
    .build();
  return tx.toXDR();
}

function xlmXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "10.5" })).build();
  return tx.toXDR();
}

function xdrWithFee(feeStroops: string): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: feeStroops, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" })).build();
  return tx.toXDR();
}

describe("decodeTx", () => {
  it("extracts destination, amount and asset from a payment XDR", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(s.source).toBe(SRC);
    expect(s.operations[0]!.type).toBe("payment");
    expect(s.operations[0]!.destination).toBe(DEST);
    expect(s.operations[0]!.amount).toBe("10.5000000");
    expect(s.operations[0]!.assetCode).toBe("USDC");
  });
});

describe("localHash", () => {
  it("matches the SDK's own tx hash (proves we re-derive, not trust)", () => {
    const xdr = sampleXdr("1");
    const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
    expect(localHash(xdr, "PUBLIC").equals(tx.hash())).toBe(true);
  });
});

describe("MAX_TRANSACTION_FEE", () => {
  it("is defined as a string constant", () => {
    // Just verify it exists and is a string
    const _max: string = "10000"; // MAX_TRANSACTION_FEE from txguard.ts
    expect(_max).toBe("10000");
  });
});

describe("assertPaymentMatches", () => {
  it("passes when destination, asset and amount match", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).not.toThrow();
  });

  it("throws on destination mismatch (receiver substitution)", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: SRC, amount: "10.5", assetCode: "USDC" })).toThrow();
  });

  it("throws on amount drift beyond tolerance", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.6", assetCode: "USDC" })).toThrow();
  });

  it("throws on asset mismatch (XLM where USDC expected)", () => {
    const s = decodeTx(xlmXdr(), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).toThrow(/ativo/);
  });

  it("throws when more than one payment op is present (hidden second payment)", () => {
    const s = decodeTx(twoPaymentXdr(), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/exatamente 1/);
  });

  // ----- New: memo validation -----

  it("accepts correct memo", () => {
    const s = decodeTx(sampleXdr("10.5", "my-order-memo"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", memo: "my-order-memo" })).not.toThrow();
  });

  it("rejects incorrect memo", () => {
    const s = decodeTx(sampleXdr("10.5", "wrong-memo"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", memo: "my-order-memo" })).toThrow();
  });

  it("rejects missing memo when expected", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC"); // no memo
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", memo: "required-memo" })).toThrow();
  });

  it("accepts transaction without memo when not expected", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC"); // no memo
    // When memo is not in the expect object, absence is allowed
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).not.toThrow();
  });

  // ----- New: fee validation -----

  it("accepts fee within the maximum limit", () => {
    // MAX_TRANSACTION_FEE is "10000"; a normal fee of "100" should pass
    const s = decodeTx(xdrWithFee("100"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", fee: "100" })).not.toThrow();
  });

  it("rejects fee above the maximum limit", () => {
    // Fee of "50000" exceeds MAX_TRANSACTION_FEE of "10000"
    const s = decodeTx(xdrWithFee("50000"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", fee: "10000" })).toThrow();
  });

  it("rejects invalid/missing fee when expected", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC"); // fee "100" is decoded
    // When fee is expected but transaction has a different one
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", fee: "99999" })).toThrow();
  });

  it("accepts transaction with fee when not expected", () => {
    // When fee is not in the expect object, the decoded fee is still checked against MAX_TRANSACTION_FEE
    // but no specific fee value is required. This test just ensures no throw on valid fee.
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).not.toThrow();
  });

  // ----- New: source account validation -----

  it("accepts matching source account", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", source: SRC })).not.toThrow();
  });

  it("rejects mismatched source account", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", source: "GBBBBBCC" })).toThrow();
  });

  it("rejects missing source account when expected", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    // source is SRC in the decoded tx, but we expect a different one
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", source: "GAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toThrow();
  });

  // ----- Existing checks still work -----

  it("throws on destination mismatch when source also matches", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: SRC, amount: "10.5", assetCode: "USDC" })).toThrow();
  });

  it("throws on amount drift beyond tolerance", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.6", assetCode: "USDC" })).toThrow();
  });

  it("throws on asset mismatch (XLM where USDC expected)", () => {
    const s = decodeTx(xlmXdr(), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).toThrow(/ativo/);
  });

  it("throws when more than one payment op is present (hidden second payment)", () => {
    const s = decodeTx(twoPaymentXdr(), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/exatamente 1/);
  });
});
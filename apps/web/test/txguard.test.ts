import { describe, it, expect } from "vitest";
import { Account, Asset, Operation, TransactionBuilder, Networks, BASE_FEE } from "@stellar/stellar-sdk";
import { decodeTx, localHash, assertPaymentMatches, ALLOWED_OP_TYPES } from "../src/lib/txguard.ts";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4Rhtm335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST = "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ";
const SRC = "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X";
const ATTACKER = "GCN2WZRWZRWZRWZRWZRWZRWZRWZRWZRWZRWZRWZRX";

function sampleXdr(amount: string): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({
      destination: DEST, asset: new Asset("USDC", ISSUER), amount,
    })).build();
  return tx.toXDR();
}

function paymentPlusOp(extra: any): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" }))
    .addOperation(extra)
    .build();
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

describe("decodeTx", () => {
  it("extracts destination, amount and asset from a payment XDR", () => {
    const s = decodeTx( sampleXdr("10.5"), "PUBLIC");
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

describe("assertPaymentMatches", () => {
  it("passes when destination, asset and amount match", () => {
    const s = decodeTx( sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).not.toThrow();
  });
  it("throws on destination mismatch (receiver substitution)", () => {
    const s = decodeTx( sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })).toThrow();
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
    const s = decodeTx( twoPaymentXdr(), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/exatamente 1/);
  });

  it("rejects a payment plus setOptions", () => {
    const s = decodeTx(paymentPlusOp(Operation.setOptions({ signer: { edL25519PublicKey: ATTACKER, weight: 1 } })), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/setOptions/);
  });
  it("rejects a payment plus changeTrust", () => {
    const s = decodeTx( paymentPlusOp(Operation.changeTrust({ asset: new Asset("EVIL", ATTACKER) })), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/changeTrust/);
  });
  it("rejects a payment plus accountMerge", () => {
    const s = decodeTx(paymentPlusOp(Operation.accountMerge({ destination: ATTACKER })), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/accountMerge/);
  });
  it("rejects a payment plus manageData", () => {
    const s = decodeTx(paymentPlusOp(Operation.manageData({ name: "x", value: "y" })), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow(/manageData/);
  });

  it("only allows the explicit operation allowlist", () => {
    expect(ALLOWED_OP_TYPES).toEqual(["payment"]);
  });

  it("throws on source account mismatch when expected", () => {
    const s = decodeTx( sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", source: DEST })).toThrow(/origem/);
  });
  it("throws on fee above the expected bound", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC", fee: "100" })).toThrow(/taxa/);
  });
});

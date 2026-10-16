import { describe, it, expect } from "vitest";
import { Account, Asset, Operation, TransactionBuilder, Networks, BASE_FEE } from "@stellar/stellar-sdk";
import { decodeTx, localHash, assertPaymentMatches, ALLOWED_OPERATION_TYPES } from "../src/lib/txguard.ts";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST = "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ";
const SRC = "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X";

function sampleXdr(amount: string): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE, networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({
      destination: DEST, asset: new Asset("USDC", ISSUER), amount,
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

function paymentPlusOpXdr(extraOp: any): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: String(Number(BASE_FEE) * 2), networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10.5" }))
    .addOperation(extraOp)
    .build();
  return tx.toXDR();
}

function paymentPlusMultiOpsXdr(extraOps: any[]): string {
  const builder = new TransactionBuilder(new Account(SRC, "123"), {
    fee: String(Number(BASE_FEE) * (1 + extraOps.length)), networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10.5" }));
  for (const op of extraOps) {
    builder.addOperation(op);
  }
  return builder.build().toXDR();
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
    expect(() => assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" })).toThrow();
  });

  it("verifies ALLOWED_OPERATION_TYPES explicitly only allows payment", () => {
    expect(ALLOWED_OPERATION_TYPES).toEqual(["payment"]);
  });

  it("throws and explicitly names setOptions when an attacker injects signer modification", () => {
    const xdr = paymentPlusOpXdr(Operation.setOptions({ masterWeight: 0 }));
    const s = decodeTx(xdr, "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })
    ).toThrow(/setOptions/);
  });

  it("throws and explicitly names changeTrust when an attacker injects rogue trustline", () => {
    const xdr = paymentPlusOpXdr(Operation.changeTrust({ asset: new Asset("EVIL", SRC) }));
    const s = decodeTx(xdr, "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })
    ).toThrow(/changeTrust/);
  });

  it("throws and explicitly names accountMerge when an attacker injects account drain", () => {
    const xdr = paymentPlusOpXdr(Operation.accountMerge({ destination: SRC }));
    const s = decodeTx(xdr, "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })
    ).toThrow(/accountMerge/);
  });

  it("throws and explicitly names manageData when an attacker injects metadata write", () => {
    const xdr = paymentPlusOpXdr(Operation.manageData({ name: "backdoor", value: "injected" }));
    const s = decodeTx(xdr, "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" })
    ).toThrow(/manageData/);
  });

  it("names all offending operation types when multiple foreign ops are injected", () => {
    const xdr = paymentPlusMultiOpsXdr([
      Operation.setOptions({ masterWeight: 0 }),
      Operation.manageData({ name: "key", value: "val" }),
    ]);
    const s = decodeTx(xdr, "PUBLIC");
    let caughtErr: Error | null = null;
    try {
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" });
    } catch (err: any) {
      caughtErr = err;
    }
    expect(caughtErr).not.toBeNull();
    expect(caughtErr!.message).toContain("setOptions");
    expect(caughtErr!.message).toContain("manageData");
  });

  it("validates source account and rejects mismatched source", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        source: SRC,
      })
    ).not.toThrow();

    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        source: DEST,
      })
    ).toThrow(/origem divergente/);
  });

  it("validates network fee bound and rejects fee exceeding maxFee", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    // fee in sampleXdr is BASE_FEE ("100")
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        maxFee: 200,
      })
    ).not.toThrow();

    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        maxFee: 50,
      })
    ).toThrow(/limite máximo permitido/);
  });
});



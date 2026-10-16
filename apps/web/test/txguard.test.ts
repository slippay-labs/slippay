import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Memo,
  Keypair,
} from "@stellar/stellar-sdk";
import crypto from "crypto";
import {
  decodeTx,
  localHash,
  assertPaymentMatches,
  parseStroops,
} from "../src/lib/txguard.ts";
import { matchPaymentToOrder } from "../../listener/src/matcher.ts";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST = "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ";
const SRC = "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X";
const ATTACKER = Keypair.random().publicKey();

function sampleXdr(
  amount: string,
  memo?: { type: "text" | "hash"; value: string | Buffer },
  fee: number | string = BASE_FEE,
): string {
  let builder = new TransactionBuilder(new Account(SRC, "123"), {
    fee: String(fee),
    networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(
    Operation.payment({
      destination: DEST,
      asset: new Asset("USDC", ISSUER),
      amount,
    }),
  );

  if (memo) {
    if (memo.type === "text") {
      builder = builder.addMemo(Memo.text(memo.value as string));
    } else if (memo.type === "hash") {
      builder = builder.addMemo(Memo.hash(memo.value));
    }
  }

  return builder.build().toXDR();
}

function twoPaymentXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" }))
    .addOperation(Operation.payment({ destination: SRC, asset: new Asset("USDC", ISSUER), amount: "999" }))
    .build();
  return tx.toXDR();
}

function injectedAccountMergeXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" }))
    .addOperation(Operation.accountMerge({ destination: ATTACKER }))
    .build();
  return tx.toXDR();
}

function injectedSetOptionsXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: new Asset("USDC", ISSUER), amount: "10" }))
    .addOperation(Operation.setOptions({ inflationDest: ATTACKER }))
    .build();
  return tx.toXDR();
}

function xlmXdr(): string {
  const tx = new TransactionBuilder(new Account(SRC, "123"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "10.5" }))
    .build();
  return tx.toXDR();
}

describe("decodeTx", () => {
  it("extracts destination, amount, asset, source, and fee from a payment XDR", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(s.source).toBe(SRC);
    expect(s.fee).toBe(String(BASE_FEE));
    expect(s.operations[0]!.type).toBe("payment");
    expect(s.operations[0]!.destination).toBe(DEST);
    expect(s.operations[0]!.amount).toBe("10.5000000");
    expect(s.operations[0]!.assetCode).toBe("USDC");
  });

  it("extracts text memo correctly", () => {
    const s = decodeTx(sampleXdr("10.5", { type: "text", value: "slip_order_123" }), "PUBLIC");
    expect(s.memo).toBe("slip_order_123");
    expect(s.memoType).toBe("text");
  });

  it("extracts 32-byte hash memo as hex string", () => {
    const hashBuf = crypto.randomBytes(32);
    const hashHex = hashBuf.toString("hex");
    const s = decodeTx(sampleXdr("10.5", { type: "hash", value: hashBuf }), "PUBLIC");
    expect(s.memo).toBe(hashHex);
    expect(s.memoType).toBe("hash");
  });
});

describe("localHash", () => {
  it("matches the SDK's own tx hash (proves we re-derive, not trust)", () => {
    const xdr = sampleXdr("1");
    const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
    expect(localHash(xdr, "PUBLIC").equals(tx.hash())).toBe(true);
  });
});

describe("parseStroops", () => {
  it("converts decimal amounts to stroops accurately", () => {
    expect(parseStroops("1")).toBe(10_000_000n);
    expect(parseStroops("10.5")).toBe(105_000_000n);
    expect(parseStroops("0.0000001")).toBe(1n);
    expect(parseStroops("100.1234567")).toBe(1_001_234_567n);
  });

  it("rejects invalid formats, negatives and excessive fractions", () => {
    expect(() => parseStroops("-1")).toThrow("guard: valor não numérico");
    expect(() => parseStroops("10.12345678")).toThrow("guard: valor não numérico");
    expect(() => parseStroops("abc")).toThrow("guard: valor não numérico");
    expect(() => parseStroops("")).toThrow("guard: valor não numérico");
  });
});

describe("assertPaymentMatches (adversarial XDR fixtures)", () => {
  it("passes when destination, asset, amount, memo, fee, and source match", () => {
    const hashBuf = crypto.randomBytes(32);
    const hashHex = hashBuf.toString("hex");
    const s = decodeTx(sampleXdr("10.5", { type: "hash", value: hashBuf }, 100), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        memo: hashHex,
        maxFee: 100,
        source: SRC,
      }),
    ).not.toThrow();
  });

  it("throws on destination mismatch (receiver substitution)", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: SRC, amount: "10.5", assetCode: "USDC" }),
    ).toThrow(/destino divergente/);
  });

  it("throws when destination differs by even one character (forged address)", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: ATTACKER, amount: "10.5", assetCode: "USDC" }),
    ).toThrow(/destino divergente/);
  });

  it("throws on asset mismatch (XLM where USDC expected)", () => {
    const s = decodeTx(xlmXdr(), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10.5", assetCode: "USDC" }),
    ).toThrow(/ativo divergente/);
  });

  it("throws on hidden second payment op", () => {
    const s = decodeTx(twoPaymentXdr(), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" }),
    ).toThrow(/esperava exatamente 1 pagamento/);
  });

  it("throws on injected accountMerge operation (unauthorized operation)", () => {
    const s = decodeTx(injectedAccountMergeXdr(), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" }),
    ).toThrow(/operações não autorizadas/);
  });

  it("throws on injected setOptions operation (unauthorized operation)", () => {
    const s = decodeTx(injectedSetOptionsXdr(), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, { destination: DEST, amount: "10", assetCode: "USDC" }),
    ).toThrow(/operações não autorizadas/);
  });

  it("detects and rejects 1-stroop difference (defeats float rounding trap)", () => {
    // 10.0000001 vs 10.0000002 has a difference of 1e-7 which passes float `> 1e-7` check!
    const s = decodeTx(sampleXdr("10.0000001"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.0000002",
        assetCode: "USDC",
      }),
    ).toThrow(/valor divergente/);
  });

  it("throws on missing memo when order requires one", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        memo: "expected_order_hash_123",
      }),
    ).toThrow(/memo ausente/);
  });

  it("throws on wrong memo (substituted order binding)", () => {
    const hashBuf = crypto.randomBytes(32);
    const s = decodeTx(sampleXdr("10.5", { type: "hash", value: hashBuf }), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        memo: "different_memo_hash_999",
      }),
    ).toThrow(/memo divergente/);
  });

  it("throws on excessive network fee", () => {
    const s = decodeTx(sampleXdr("10.5", undefined, 500_000), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        maxFee: 10_000,
      }),
    ).toThrow(/taxa de rede excessiva/);
  });

  it("throws on source account mismatch", () => {
    const s = decodeTx(sampleXdr("10.5"), "PUBLIC");
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: "10.5",
        assetCode: "USDC",
        source: ATTACKER,
      }),
    ).toThrow(/conta de origem divergente/);
  });
});

describe("Cross-reference: Guard-accepted transaction satisfies Listener's matching rules", () => {
  it("asserts a guard-approved transaction matches listener rules perfectly using identical vector", () => {
    const memoBytes = crypto.randomBytes(32);
    const memoHex = memoBytes.toString("hex");
    const memoB64 = memoBytes.toString("base64");
    const amountStr = "25.5000000";

    const xdr = sampleXdr(amountStr, { type: "hash", value: memoBytes }, 100);
    const s = decodeTx(xdr, "PUBLIC");

    // 1. Client Guard asserts and approves
    expect(() =>
      assertPaymentMatches(s, {
        destination: DEST,
        amount: amountStr,
        assetCode: "USDC",
        memo: memoHex,
        maxFee: 1000,
        source: SRC,
      }),
    ).not.toThrow();

    // 2. Cross-reference to Listener's matcher
    const pay = s.operations[0]!;
    const paymentEvent = {
      memo_type: "hash",
      memo_b64: memoB64,
      successful: true,
      asset_code: pay.assetCode,
      asset_issuer: ISSUER,
      to: pay.destination!,
      amount: pay.amount!,
      hash: "mock_tx_hash",
    };

    const order = {
      id: "ord_cross_ref_test",
      memo: memoHex,
      usdc_amount: amountStr,
      merchant_stellar_address: DEST,
      platform_fee_bp: 0,
    };

    // Override issuer for testing match
    process.env.STELLAR_USDC_ISSUER_OVERRIDE = ISSUER;
    const match = matchPaymentToOrder(paymentEvent, order, "PUBLIC");
    expect(match).toEqual({ outcome: "paid" });
  });

  it("asserts listener rejects when adversarial attack alters amount or memo", () => {
    const memoBytes = crypto.randomBytes(32);
    const memoHex = memoBytes.toString("hex");

    // Underpaid event
    const underpaidEvent = {
      memo_type: "hash",
      memo_b64: memoBytes.toString("base64"),
      successful: true,
      asset_code: "USDC",
      asset_issuer: ISSUER,
      to: DEST,
      amount: "10.0000000",
      hash: "mock_tx_hash",
    };

    const order = {
      id: "ord_cross_ref_test",
      memo: memoHex,
      usdc_amount: "20.0000000",
      merchant_stellar_address: DEST,
      platform_fee_bp: 0,
    };

    process.env.STELLAR_USDC_ISSUER_OVERRIDE = ISSUER;
    const matchUnderpaid = matchPaymentToOrder(underpaidEvent, order, "PUBLIC");
    expect(matchUnderpaid.outcome).toBe("underpaid");

    // Wrong memo event
    const wrongMemoEvent = {
      ...underpaidEvent,
      amount: "20.0000000",
      memo_b64: crypto.randomBytes(32).toString("base64"),
    };
    const matchWrongMemo = matchPaymentToOrder(wrongMemoEvent, order, "PUBLIC");
    expect(matchWrongMemo.outcome).toBe("ignore");
  });
});

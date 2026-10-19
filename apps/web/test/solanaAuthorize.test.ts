import { describe, it, expect, test } from "vitest";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  decodeUsdcTransfer,
  assertTransferMatches,
} from "../src/lib/solanaAuthorize.ts";
import { usdcMint, USDC_DECIMALS } from "../src/lib/chain/solana/usdc.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

const FROM = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const TO = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

/** Build a minimal TransferChecked tx with a known amount, without hitting RPC. */
function makeTransferTx(toOverride?: PublicKey, amountBaseUnits = 12_500_000n): Transaction {
  const mint = usdcMint("devnet");
  const dest = toOverride ?? TO;
  const fromAta = getAssociatedTokenAddressSync(mint, FROM, true);
  const toAta = getAssociatedTokenAddressSync(mint, dest, true);

  const ix = createTransferCheckedInstruction(
    fromAta,
    mint,
    toAta,
    FROM,
    amountBaseUnits,
    USDC_DECIMALS,
  );

  const tx = new Transaction();
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  tx.feePayer = FROM;
  tx.add(ix);
  return tx;
}

/** Build a tx with a non-TransferChecked SPL instruction (discriminant != 12). */
function makeNonTransferCheckedTx(): Transaction {
  const mint = usdcMint("devnet");
  const fromAta = getAssociatedTokenAddressSync(mint, FROM, true);
  const toAta = getAssociatedTokenAddressSync(mint, TO, true);

  const ix = createTransferCheckedInstruction(
    fromAta,
    mint,
    toAta,
    FROM,
    1_000_000n,
    USDC_DECIMALS,
  );
  ix.data[0] = 3;

  const tx = new Transaction();
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  tx.feePayer = FROM;
  tx.add(ix);
  return tx;
}

// ---------------------------------------------------------------------------
// decodeUsdcTransfer
// ---------------------------------------------------------------------------

describe("decodeUsdcTransfer", () => {
  it("extracts correct destination ATA from a built transfer", () => {
    const tx = makeTransferTx();
    const decoded = decodeUsdcTransfer(tx);
    const mint = usdcMint("devnet");
    const expectedToAta = getAssociatedTokenAddressSync(mint, TO, true).toBase58();
    expect(decoded.to).toBe(expectedToAta);
  });

  it("extracts correct USDC amount (12.5 USDC = 12500000 base units)", () => {
    const tx = makeTransferTx(undefined, 12_500_000n);
    const decoded = decodeUsdcTransfer(tx);
    expect(Number(decoded.amount)).toBeCloseTo(12.5, 6);
  });

  it("extracts correct USDC amount for a whole number (100 USDC)", () => {
    const tx = makeTransferTx(undefined, 100_000_000n);
    const decoded = decodeUsdcTransfer(tx);
    expect(decoded.amount).toBe("100");
  });

  it("throws on a transaction with no instructions", () => {
    const tx = new Transaction();
    tx.recentBlockhash = DUMMY_BLOCKHASH;
    tx.feePayer = FROM;
    expect(() => decodeUsdcTransfer(tx)).toThrow(/no instructions/);
  });

  it("throws when instruction discriminant is not TransferChecked (byte 0 != 12)", () => {
    const tx = makeNonTransferCheckedTx();
    expect(() => decodeUsdcTransfer(tx)).toThrow(/instrução SPL inesperada/);
  });

  it("does NOT throw on a valid TransferChecked instruction (discriminant = 12)", () => {
    const tx = makeTransferTx();
    expect(() => decodeUsdcTransfer(tx)).not.toThrow();
  });

  // Table-driven tests covering malformed shapes and valid transfer
  describe("table-tests for malformed shapes and valid transfer", () => {
    const cases = [
      {
        name: "no instructions",
        buildTx: () => {
          const tx = new Transaction();
          tx.recentBlockhash = DUMMY_BLOCKHASH;
          tx.feePayer = FROM;
          return tx;
        },
        expectedError: /transaction has no instructions/,
      },
      {
        name: "invalid discriminant byte (opcode != 12)",
        buildTx: () => makeNonTransferCheckedTx(),
        expectedError: /instrução SPL inesperada/,
      },
      {
        name: "unexpected instruction account count (keys.length < 3)",
        buildTx: () => {
          const tx = new Transaction();
          tx.recentBlockhash = DUMMY_BLOCKHASH;
          tx.feePayer = FROM;
          const badIx = new TransactionInstruction({
            programId: PublicKey.default,
            keys: [
              { pubkey: FROM, isSigner: true, isWritable: true },
              { pubkey: TO, isSigner: false, isWritable: true },
            ], // Only 2 accounts, expects >= 3
            data: Buffer.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
          });
          tx.add(badIx);
          return tx;
        },
        expectedError: /unexpected instruction account count/,
      },
      {
        name: "instruction data too short to decode amount (data.length < 10)",
        buildTx: () => {
          const tx = new Transaction();
          tx.recentBlockhash = DUMMY_BLOCKHASH;
          tx.feePayer = FROM;
          const badIx = new TransactionInstruction({
            programId: PublicKey.default,
            keys: [
              { pubkey: FROM, isSigner: true, isWritable: true },
              { pubkey: PublicKey.default, isSigner: false, isWritable: false },
              { pubkey: TO, isSigner: false, isWritable: true },
            ],
            data: Buffer.from([12, 1, 2, 3]), // only 4 bytes, expects >= 10
          });
          tx.add(badIx);
          return tx;
        },
        expectedError: /instruction data too short to decode amount/,
      },
      {
        name: "valid transfer",
        buildTx: () => makeTransferTx(),
        expectedError: null,
      },
    ];

    test.each(cases)("$name", ({ buildTx, expectedError }) => {
      const tx = buildTx();
      if (expectedError) {
        expect(() => decodeUsdcTransfer(tx)).toThrow(expectedError);
      } else {
        const decoded = decodeUsdcTransfer(tx);
        expect(decoded).toHaveProperty("to");
        expect(decoded).toHaveProperty("amount");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// assertTransferMatches
// ---------------------------------------------------------------------------

describe("assertTransferMatches", () => {
  it("passes on exact match", () => {
    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "12.5" },
        { to: "AAAA", amount: "12.5" },
      ),
    ).not.toThrow();
  });

  it("throws on destination mismatch", () => {
    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "12.5" },
        { to: "BBBB", amount: "12.5" },
      ),
    ).toThrow(/destino divergente/);
  });

  it("throws on amount drift beyond 1e-6", () => {
    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "12.5" },
        { to: "AAAA", amount: "12.500002" },
      ),
    ).toThrow(/valor divergente/);
  });

  it("passes when amount differs by exactly 1e-6 (boundary — within tolerance)", () => {
    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "12.5" },
        { to: "AAAA", amount: "12.500001" },
      ),
    ).not.toThrow();
  });

  it("throws on non-numeric amount", () => {
    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "not-a-number" },
        { to: "AAAA", amount: "12.5" },
      ),
    ).toThrow(/valor não numérico/);

    expect(() =>
      assertTransferMatches(
        { to: "AAAA", amount: "12.5" },
        { to: "AAAA", amount: "NaN" },
      ),
    ).toThrow(/valor não numérico/);
  });

  // Table-driven tests for assertTransferMatches
  describe("table-tests for assertTransferMatches", () => {
    const tableCases = [
      {
        name: "matching pair",
        decoded: { to: "DEST_ATA_1", amount: "50.00" },
        expected: { to: "DEST_ATA_1", amount: "50.00" },
        expectedError: null,
      },
      {
        name: "matching pair with whitespace in destination",
        decoded: { to: " DEST_ATA_1 ", amount: "50.00" },
        expected: { to: "DEST_ATA_1", amount: "50.00" },
        expectedError: null,
      },
      {
        name: "mismatched destination",
        decoded: { to: "ATTACKER_ATA", amount: "50.00" },
        expected: { to: "MERCHANT_ATA", amount: "50.00" },
        expectedError: /destino divergente/,
      },
      {
        name: "non-numeric decoded amount",
        decoded: { to: "DEST_ATA_1", amount: "invalid_amount" },
        expected: { to: "DEST_ATA_1", amount: "50.00" },
        expectedError: /valor não numérico/,
      },
      {
        name: "non-numeric expected amount",
        decoded: { to: "DEST_ATA_1", amount: "50.00" },
        expected: { to: "DEST_ATA_1", amount: "xyz" },
        expectedError: /valor não numérico/,
      },
      {
        name: "excessive amount drift",
        decoded: { to: "DEST_ATA_1", amount: "50.000000" },
        expected: { to: "DEST_ATA_1", amount: "50.000010" },
        expectedError: /valor divergente/,
      },
    ];

    test.each(tableCases)("$name", ({ decoded, expected, expectedError }) => {
      if (expectedError) {
        expect(() => assertTransferMatches(decoded, expected)).toThrow(expectedError);
      } else {
        expect(() => assertTransferMatches(decoded, expected)).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Gate order: sign never called before confirm
// ---------------------------------------------------------------------------

describe("authorizeSolanaPayment gate order", () => {
  it("never calls signTransaction when confirm returns false (declined confirmation)", async () => {
    const { authorizeSolanaPayment } = await import("../src/lib/solanaAuthorize.ts");

    const signCalled: boolean[] = [];
    const fakeSign = async (tx: Transaction): Promise<Transaction> => {
      signCalled.push(true);
      return tx;
    };

    const fakeConn = {
      getLatestBlockhash: async () => ({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0 }),
    } as unknown as Connection;

    await expect(
      authorizeSolanaPayment({
        connection: fakeConn,
        from: FROM,
        to: TO,
        usdcAmount: "1",
        signTransaction: fakeSign,
        confirm: async (_decoded) => false, // human rejects
      }),
    ).rejects.toThrow(/cancelado pelo usuário/);

    // CRITICAL: A declined confirmation must result in zero signing calls.
    expect(signCalled).toHaveLength(0);
  });

  it("never calls signTransaction when confirm throws (throwing confirmation)", async () => {
    const { authorizeSolanaPayment } = await import("../src/lib/solanaAuthorize.ts");

    const signCalled: boolean[] = [];
    const fakeSign = async (tx: Transaction): Promise<Transaction> => {
      signCalled.push(true);
      return tx;
    };

    const fakeConn = {
      getLatestBlockhash: async () => ({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0 }),
    } as unknown as Connection;

    await expect(
      authorizeSolanaPayment({
        connection: fakeConn,
        from: FROM,
        to: TO,
        usdcAmount: "1",
        signTransaction: fakeSign,
        confirm: async (_decoded) => {
          throw new Error("UI confirmation modal closed abruptly");
        },
      }),
    ).rejects.toThrow(/UI confirmation modal closed abruptly/);

    // CRITICAL: A throwing confirmation must result in zero signing calls.
    expect(signCalled).toHaveLength(0);
  });

  it("asserts decoded values passed to confirm equal the values that passed the check", async () => {
    const { authorizeSolanaPayment } = await import("../src/lib/solanaAuthorize.ts");

    const fakeConn = {
      getLatestBlockhash: async () => ({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0 }),
    } as unknown as Connection;

    let capturedConfirmPayload: { to: string; amount: string; ownerAddress: string } | null = null;

    const requestedAmount = "25.75";
    await expect(
      authorizeSolanaPayment({
        connection: fakeConn,
        from: FROM,
        to: TO,
        usdcAmount: requestedAmount,
        signTransaction: async (tx) => tx,
        confirm: async (decoded) => {
          capturedConfirmPayload = decoded;
          return false; // cancel after capturing
        },
      }),
    ).rejects.toThrow(/cancelado pelo usuário/);

    expect(capturedConfirmPayload).not.toBeNull();
    // 1. Amount passed to human confirm matches the asserted requested amount
    expect(capturedConfirmPayload!.amount).toBe(requestedAmount);
    // 2. Owner address is base58 of TO recipient
    expect(capturedConfirmPayload!.ownerAddress).toBe(TO.toBase58());
    // 3. Destination ATA is the derived ATA for TO
    const mint = usdcMint("devnet");
    const expectedToAta = getAssociatedTokenAddressSync(mint, TO, true).toBase58();
    expect(capturedConfirmPayload!.to).toBe(expectedToAta);
  });
});

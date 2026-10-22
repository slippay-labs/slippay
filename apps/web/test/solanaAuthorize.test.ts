import { describe, it, expect } from "vitest";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
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

  // Build a valid TransferChecked instruction then mutate the discriminant byte.
  const ix = createTransferCheckedInstruction(
    fromAta,
    mint,
    toAta,
    FROM,
    1_000_000n,
    USDC_DECIMALS,
  );
  // Overwrite the first byte with discriminant 3 (Transfer, not TransferChecked).
  ix.data[0] = 3;

  const tx = new Transaction();
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  tx.feePayer = FROM;
  tx.add(ix);
  return tx;
}

/** Build a tx with fewer than 3 accounts in keys. */
function makeFewAccountsTx(): Transaction {
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
  ix.keys = ix.keys.slice(0, 2);

  const tx = new Transaction();
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  tx.feePayer = FROM;
  tx.add(ix);
  return tx;
}

/** Build a tx with truncated instruction data (< 10 bytes). */
function makeTruncatedDataTx(): Transaction {
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
  ix.data = ix.data.slice(0, 5);

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
    // 12.5 USDC = 12_500_000 base units at 6 dp
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

  // [M-1] Validate that a non-TransferChecked instruction is rejected.
  it("[M-1] throws when instruction discriminant is not TransferChecked (byte 0 != 12)", () => {
    const tx = makeNonTransferCheckedTx();
    expect(() => decodeUsdcTransfer(tx)).toThrow(/instrução SPL inesperada/);
  });

  it("[M-1] does NOT throw on a valid TransferChecked instruction (discriminant = 12)", () => {
    const tx = makeTransferTx();
    expect(() => decodeUsdcTransfer(tx)).not.toThrow();
  });

  // Table-test malformed shapes rejected by decodeUsdcTransfer
  it.each([
    {
      name: "no instructions",
      buildTx: () => {
        const tx = new Transaction();
        tx.recentBlockhash = DUMMY_BLOCKHASH;
        tx.feePayer = FROM;
        return tx;
      },
      errorPattern: /no instructions/,
    },
    {
      name: "insufficient account keys (< 3)",
      buildTx: makeFewAccountsTx,
      errorPattern: /unexpected instruction account count/,
    },
    {
      name: "truncated instruction data (< 10 bytes)",
      buildTx: makeTruncatedDataTx,
      errorPattern: /instruction data too short to decode amount/,
    },
    {
      name: "non-TransferChecked discriminant",
      buildTx: makeNonTransferCheckedTx,
      errorPattern: /instrução SPL inesperada/,
    },
  ])("rejects malformed shape: $name", ({ buildTx, errorPattern }) => {
    const tx = buildTx();
    expect(() => decodeUsdcTransfer(tx)).toThrow(errorPattern);
  });

  it("valid transfer satisfies all decode requirements", () => {
    const tx = makeTransferTx();
    const result = decodeUsdcTransfer(tx);
    expect(result).toHaveProperty("to");
    expect(result).toHaveProperty("amount");
    expect(typeof result.to).toBe("string");
    expect(typeof result.amount).toBe("string");
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

  it("throws when signTransaction would sign a different destination than confirmed", () => {
    const attackerAta = "attacker111111111111111111111111111111111";
    const userExpected = "correct2222222222222222222222222222222222";
    expect(() =>
      assertTransferMatches(
        { to: attackerAta, amount: "100" },
        { to: userExpected, amount: "100" },
      ),
    ).toThrow(/destino divergente/);
  });

  // Table test assertTransferMatches failure and success paths
  it.each([
    {
      name: "non-numeric decoded amount",
      decoded: { to: "DEST", amount: "not-a-number" },
      expected: { to: "DEST", amount: "10" },
      errorPattern: /valor não numérico/,
    },
    {
      name: "non-numeric expected amount",
      decoded: { to: "DEST", amount: "10" },
      expected: { to: "DEST", amount: "NaN" },
      errorPattern: /valor não numérico/,
    },
    {
      name: "mismatched destination address",
      decoded: { to: "DEST_A", amount: "50" },
      expected: { to: "DEST_B", amount: "50" },
      errorPattern: /destino divergente/,
    },
    {
      name: "amount difference exceeding 1e-6",
      decoded: { to: "DEST", amount: "10.000000" },
      expected: { to: "DEST", amount: "10.000010" },
      errorPattern: /valor divergente/,
    },
  ])("rejects invalid transfer pairing: $name", ({ decoded, expected, errorPattern }) => {
    expect(() => assertTransferMatches(decoded, expected)).toThrow(errorPattern);
  });

  it.each([
    {
      name: "matching destination and exact amount",
      decoded: { to: "DEST_OK", amount: "42.123456" },
      expected: { to: "DEST_OK", amount: "42.123456" },
    },
    {
      name: "matching destination with tolerance <= 1e-6",
      decoded: { to: "DEST_OK", amount: "100.000000" },
      expected: { to: "DEST_OK", amount: "100.000001" },
    },
  ])("accepts valid transfer pairing: $name", ({ decoded, expected }) => {
    expect(() => assertTransferMatches(decoded, expected)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gate order: sign never called before confirm
// ---------------------------------------------------------------------------

describe("authorizeSolanaPayment gate order", () => {
  it("never calls signTransaction when confirm returns false", async () => {
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
        confirm: async (_decoded) => false, // user rejects
      }),
    ).rejects.toThrow(/cancelado/);

    expect(signCalled).toHaveLength(0);
  });

  it("never calls signTransaction when confirm callback throws an error", async () => {
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
        confirm: async () => {
          throw new Error("modal dismissed unexpectedly");
        },
      }),
    ).rejects.toThrow(/modal dismissed unexpectedly/);

    expect(signCalled).toHaveLength(0);
  });

  it("passes ownerAddress (base58 owner, not ATA) to confirm callback", async () => {
    const { authorizeSolanaPayment } = await import("../src/lib/solanaAuthorize.ts");

    const fakeConn = {
      getLatestBlockhash: async () => ({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0 }),
    } as unknown as Connection;

    let capturedOwner: string | undefined;

    await expect(
      authorizeSolanaPayment({
        connection: fakeConn,
        from: FROM,
        to: TO,
        usdcAmount: "1",
        signTransaction: async (tx) => tx,
        confirm: async (decoded) => {
          capturedOwner = decoded.ownerAddress;
          return false;
        },
      }),
    ).rejects.toThrow(/cancelado/);

    expect(capturedOwner).toBe(TO.toBase58());
  });

  it("asserts that values shown to confirm callback match the validated values", async () => {
    const { authorizeSolanaPayment } = await import("../src/lib/solanaAuthorize.ts");

    const fakeConn = {
      getLatestBlockhash: async () => ({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0 }),
    } as unknown as Connection;

    let receivedInConfirm: { to: string; amount: string; ownerAddress: string } | undefined;

    await expect(
      authorizeSolanaPayment({
        connection: fakeConn,
        from: FROM,
        to: TO,
        usdcAmount: "15.75",
        signTransaction: async (tx) => tx,
        confirm: async (decoded) => {
          receivedInConfirm = decoded;
          return false; // abort before send
        },
      }),
    ).rejects.toThrow(/cancelado/);

    expect(receivedInConfirm).toBeDefined();
    const mint = usdcMint("devnet");
    const expectedToAta = getAssociatedTokenAddressSync(mint, TO, true).toBase58();

    // Confirm callback receives exactly what was machine-verified
    expect(receivedInConfirm!.to).toBe(expectedToAta);
    expect(receivedInConfirm!.amount).toBe("15.75");
    expect(receivedInConfirm!.ownerAddress).toBe(TO.toBase58());
  });
});

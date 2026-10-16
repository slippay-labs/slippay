import { TransactionBuilder, Networks, StrKey } from "@stellar/stellar-sdk";

const PASS: Record<string, string> = { TESTNET: Networks.TESTNET, PUBLIC: Networks.PUBLIC };

export interface OpSummary {
  type: string;
  destination?: string;
  amount?: string;
  assetCode?: string;
}

export interface TxSummary {
  source: string;
  fee: string;
  memo?: string;
  memoType?: string;
  operations: OpSummary[];
}

export interface PaymentExpectation {
  destination: string;
  amount: string;
  assetCode: string;
  memo?: string;
  maxFee?: string | number;
  source?: string;
}

export function decodeTx(xdr: string, network: "TESTNET" | "PUBLIC"): TxSummary {
  const tx = TransactionBuilder.fromXDR(xdr, PASS[network]!) as any;
  const ops: OpSummary[] = (tx.operations ?? []).map((op: any) => {
    if (op.type === "payment") {
      return {
        type: "payment",
        destination: op.destination,
        amount: op.amount,
        assetCode: op.asset?.isNative?.() ? "XLM" : op.asset?.code,
      };
    }
    return { type: op.type };
  });

  let memoVal: string | undefined;
  let memoType: string | undefined;
  if (tx.memo && tx.memo.type && tx.memo.type !== "none") {
    memoType = tx.memo.type;
    const rawVal = tx.memo.value;
    if (rawVal !== undefined && rawVal !== null) {
      if (memoType === "text") {
        memoVal = typeof rawVal === "string" ? rawVal : Buffer.from(rawVal).toString("utf8");
      } else if (memoType === "hash" || memoType === "return") {
        memoVal = Buffer.from(rawVal).toString("hex");
      } else {
        memoVal = String(rawVal);
      }
    }
  }

  return {
    source: tx.source,
    fee: String(tx.fee),
    memo: memoVal,
    memoType,
    operations: ops,
  };
}

export function localHash(xdr: string, network: "TESTNET" | "PUBLIC"): Buffer {
  return TransactionBuilder.fromXDR(xdr, PASS[network]!).hash();
}

export function isValidStellarAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Parses a decimal Stellar amount ("12.3456789") into integer BigInt stroops.
 * Precision is strictly bounded to 7 decimal fractions.
 */
export function parseStroops(s: string): bigint {
  if (typeof s !== "string" || !/^\d+(\.\d{1,7})?$/.test(s.trim())) {
    throw new Error("guard: valor não numérico");
  }
  const [intPart, fracPartRaw = ""] = s.trim().split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * 10_000_000n + BigInt(fracPart);
}

export function assertPaymentMatches(
  s: TxSummary,
  expect: PaymentExpectation,
): void {
  // 1. Assert exactly 1 operation and it must be a payment (reject injected operations)
  const pays = s.operations.filter((o) => o.type === "payment");
  if (pays.length !== 1) {
    throw new Error(`guard: esperava exatamente 1 pagamento, encontrei ${pays.length}`);
  }
  if (s.operations.length !== 1) {
    throw new Error(
      `guard: transação contém operações não autorizadas (esperado 1 operação de pagamento, encontrei ${s.operations.length})`,
    );
  }

  // 2. Assert source account if specified
  if (expect.source !== undefined && s.source !== expect.source) {
    throw new Error(
      `guard: conta de origem divergente (assinaria ${s.source}, esperado ${expect.source})`,
    );
  }

  // 3. Assert fee bound if specified
  if (expect.maxFee !== undefined) {
    const feeStroops = BigInt(s.fee);
    const maxFeeStroops = BigInt(expect.maxFee);
    if (feeStroops > maxFeeStroops) {
      throw new Error(
        `guard: taxa de rede excessiva (taxa ${s.fee}, máximo permitido ${expect.maxFee})`,
      );
    }
  }

  const pay = pays[0]!;

  // 4. Assert destination address
  if (pay.destination !== expect.destination.trim()) {
    throw new Error(
      `guard: destino divergente (assinaria ${pay.destination}, esperado ${expect.destination})`,
    );
  }

  // 5. Assert asset code
  if (pay.assetCode !== expect.assetCode) {
    throw new Error(`guard: ativo divergente (${pay.assetCode} vs ${expect.assetCode})`);
  }

  // 6. Assert amount with exact stroop comparison (rejects 1-stroop drift and float imprecision)
  if (!pay.amount || !expect.amount) {
    throw new Error("guard: valor não numérico");
  }
  const gotStroops = parseStroops(pay.amount);
  const wantStroops = parseStroops(expect.amount);
  if (gotStroops !== wantStroops) {
    throw new Error(
      `guard: valor divergente (assinaria ${pay.amount}, esperado ${expect.amount})`,
    );
  }

  // 7. Assert memo if expected
  if (expect.memo !== undefined) {
    if (!s.memo) {
      throw new Error(`guard: memo ausente (esperado ${expect.memo})`);
    }
    if (s.memo.toLowerCase() !== expect.memo.toLowerCase()) {
      throw new Error(
        `guard: memo divergente (assinaria ${s.memo}, esperado ${expect.memo})`,
      );
    }
  }
}

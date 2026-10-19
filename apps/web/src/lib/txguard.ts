import { TransactionBuilder, Networks, StrKey } from "@stellar/stellar-sdk";

const PASS: Record<string, string> = { TESTNET: Networks.TESTNET, PUBLIC: Networks.PUBLIC };

export interface OpSummary { type: string; destination?: string; amount?: string; assetCode?: string }
export interface TxSummary { source: string; fee: string; memo?: string; operations: OpSummary[] }

export const MAX_TRANSACTION_FEE = "10000"; // 10,000 stroops = 0.0001 XLM max; normal base fee is 100 stroops

export function decodeTx(xdr: string, network: "TESTNET" | "PUBLIC"): TxSummary {
  const tx = TransactionBuilder.fromXDR(xdr, PASS[network]!) as any;
  const ops: OpSummary[] = (tx.operations ?? []).map((op: any) => {
    if (op.type === "payment") {
      return { type: "payment", destination: op.destination, amount: op.amount,
               assetCode: op.asset?.isNative?.() ? "XLM" : op.asset?.code };
    }
    return { type: op.type };
  });
  return {
    source: tx.source,
    fee: String(tx.fee),
    memo: (tx.memo && tx.memo.type === "text" && typeof tx.memo.value === "string") ? tx.memo.value : undefined,
    operations: ops,
  };
}

export function localHash(xdr: string, network: "TESTNET" | "PUBLIC"): Buffer {
  return TransactionBuilder.fromXDR(xdr, PASS[network]!).hash();
}

export function isValidStellarAddress(address: string): boolean {
  try { return StrKey.isValidEd25519PublicKey(address); } catch { return false; }
}

export function assertPaymentMatches(
  s: TxSummary,
  expect: { destination: string; amount: string; assetCode: string; memo?: string; fee?: string; source?: string },
): void {
  const pays = s.operations.filter((o) => o.type === "payment");
  if (pays.length !== 1) {
    throw new Error(`guard: esperava exatamente 1 pagamento, encontrei ${pays.length}`);
  }
  const pay = pays[0]!;
  if (pay.destination !== expect.destination.trim()) {
    throw new Error(`guard: destino divergente (assinaria ${pay.destination}, esperado ${expect.destination})`);
  }
  if (pay.assetCode !== expect.assetCode) {
    throw new Error(`guard: ativo divergente (${pay.assetCode} vs ${expect.assetCode})`);
  }
  const got = Number(pay.amount);
  const want = Number(expect.amount);
  if (!Number.isFinite(got) || !Number.isFinite(want)) {
    throw new Error("guard: valor não numérico");
  }
  if (Math.abs(got - want) > 1e-7) {
    throw new Error(`guard: valor divergente (assinaria ${pay.amount}, esperado ${expect.amount})`);
  }
  // --- Memo validation ---
  if (expect.memo !== undefined) {
    if (s.memo === undefined) {
      throw new Error(`guard: memo esperado mas ausente na transação`);
    }
    if (s.memo !== expect.memo) {
      throw new Error(`guard: memo divergente (assinaria ${s.memo}, esperado ${expect.memo})`);
    }
  } else if (s.memo !== undefined) {
    // Expectation does not require a memo but transaction has one;
    // still validate it matches the order memo if the order expects none.
    // For now, we allow it (the order context controls this).
  }
  // --- Fee validation ---
  if (expect.fee !== undefined) {
    // Compare decoded fee against the maximum allowed fee.
    const gotFee = String(s.fee);
    if (gotFee > MAX_TRANSACTION_FEE) {
      throw new Error(`guard: taxa de transação acima do limite máximo (${gotFee} > ${MAX_TRANSACTION_FEE} stroops)`);
    }
    if (gotFee !== expect.fee) {
      throw new Error(`guard: taxa divergente (assinaria ${s.fee}, esperado ${expect.fee})`);
    }
  }
  // --- Source account validation ---
  if (expect.source !== undefined) {
    if (s.source !== expect.source) {
      throw new Error(`guard: source account divergente (assinaria ${s.source}, esperado ${expect.source})`);
    }
  }
}
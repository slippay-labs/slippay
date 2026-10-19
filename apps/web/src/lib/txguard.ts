import { TransactionBuilder, Networks, StrKey } from "@stellar/stellar-sdk";

const PASS: Record<string, string> = { TESTNET: Networks.TESTNET, PUBLIC: Networks.PUBLIC };

// Only these operation types are ever acceptable in a guarded transaction.
// Enumerate and reject; do not enumerate and permit.
export const ALLOWED_OP_TYPES: readonly string[] = ["payment"];

export interface OpSummary { type: string; destination?: string; amount?: string; assetCode?: string }
export interface TxSummary { source: string; fee: string; memo?: string; operations: OpSummary[] }

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
  expect: { destination: string; amount: string; assetCode: string; source?: string; fee?: string },
): void {
  // 1. Reject any operation type outside the explicit allowlist.
  const unexpected = Array.from(new Set(
    s.operations.map((o) => o.type).filter((t) => !ALLOWED_OP_TYPES.includes(t)),
  ));
  if (unexpected.length > 0) {
    throw new Error(`guard: operações não permitidas (${unexpected.join(", ")})`);
  }

  // 2. Exactly one payment operation.
  const pays = s.operations.filter((o) => o.type === "payment");
  if (pays.length !== 1) {
    throw new Error(`guard: esperava exatamente 1 pagamento, encontrei ${pays.length}`);
  }

  // 3. Number of operations must equal the number expected.
  if (s.operations.length !== 1) {
    throw new Error(`guard: esperava exatamente 1 operação, encontrei ${s.operations.length}`);
  }

  // 4. Source account must match the expected signer, when provided.
  if (expect.source !== undefined && s.source !== expect.source.trim()) {
    throw new Error(`guard: conta de origem divergente (assinaria ${s.source}, esperado ${expect.source})`);
  }

  // 5. Fee bound: the transaction must not exceed the expected fee ceiling.
  if (expect.fee !== undefined) {
    const gotFee = Number(s.fee);
    const maxFee = Number(expect.fee);
    if (!Number.isFinite(gotFee) || !Number.isFinite(maxFee)) {
      throw new Error("guard: taxa não numérica");
    }
    if (gotFee > maxFee) {
      throw new Error(`guard: taxa acima do limite (assinaria ${s.fee}, máximo ${expect.fee})`);
    }
  }

  const pay = pays[0]!;
  if (pay.destination !== expect.destination.trim()) {
    throw new Error(`guard: destino digergente (assinaria ${pay.destination}, esperado ${expect.destination})`);
  }
  if (pay.assetCode !== expect.assetCode) {
    throw new Error(`guard: ativo digergente (${pay.assetCode} vs ${expect.assetCode})`);
  }
  const got = Number(pay.amount);
  const want = Number(expect.amount);
  if (!Number.isFinite(got) || !Number.isFinite(want)) {
    throw new Error("guard: valor não numérico");
  }
  if (Math.abs(got - want) > 1e-7) {
    throw new Error(`guard: valor divergente (assinaria ${pay.amount}, esperado ${expect.amount})`);
  }
}

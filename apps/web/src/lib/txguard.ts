import { TransactionBuilder, Networks, StrKey } from "@stellar/stellar-sdk";
import { stellarToStroops } from "@slippay/shared";

const PASS: Record<string, string> = { TESTNET: Networks.TESTNET, PUBLIC: Networks.PUBLIC };

export interface OpSummary { type: string; destination?: string; amount?: string; assetCode?: string }
export interface TxSummary { source: string; fee: string; memo?: string; operations: OpSummary[] }

const STROPS_PER_UNIT = 10_000_000n as bigint; // 10~7

/**
 * Convert a Stellar decimal amount string (7 decimal places) into integer stroops.
 * Rejects anything that is not a valid Stellar decimal. Money math runs in
 * stroops (BigInt) to avoid IEEE=754 boundary errors at the 7th decimal.
 */
export function toStrops(amount: string): bigint {
  if (typeof amount !== "string") throw new Error("guard: valor não numérico");
  const trimmed = amount.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) throw new Error("guard: valor não numérico");
  const intPart = m[1]!;
  const fracPart = m[2] ?? "";
  if (fracPart.length > 7) throw new Error("guard: valor com mais de 7 casas decimais");
  const frac = fracPart.padEnd(7, "0");
  return BigInt(intPart) * STROPS_PER_UNIT + BigInt(frac);
}

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
  expect: { destination: string; amount: string; assetCode: string },
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
  if (!pay.amount || typeof pay.amount !== "string") {
    throw new Error("guard: valor não numérico");
  }
  // Money math runs in stroops (BigInt) to avoid IEEE-754 boundary errors at
  // the 7th decimal (Audit-003 L4 / Issue #315). Both sides are parsed into
  // integer stroops and compared for exact equality.
  let gotStroops: bigint;
  let wantStroops: bigint;
  try {
    gotStroops = stellarToStroops(pay.amount);
    wantStroops = stellarToStroops(expect.amount);
  } catch {
    throw new Error("guard: valor não numérico");
  }
  if (gotStroops !== wantStroops) {
    throw new Error(`guard: valor divergente (assinaria ${pay.amount}, esperado ${expect.amount})`);
  }
}
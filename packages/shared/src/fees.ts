import feeVectors from "./vectors/fee_vectors.json";

export interface FeeVector {
  id: string;
  description: string;
  amount_stroops: string;
  amount_stellar: string;
  fee_bps: number;
  expected_fee_stroops: string;
  expected_net_stroops: string;
  expected_fee_stellar: string;
  expected_net_stellar: string;
}

export const FEE_VECTORS: FeeVector[] = feeVectors as FeeVector[];

/**
 * Canonical platform fee calculation reference implementation.
 *
 * Implements integer stroop arithmetic with floor division:
 *   fee_stroops = (amount_stroops * fee_bps) / 10000
 *   net_stroops = amount_stroops - fee_stroops
 *
 * Invariant: net_stroops + fee_stroops === amount_stroops
 * Rounding: Truncation toward zero. Sub-stroop remainder is retained by the merchant net.
 */
export function calculateFeeSplit(
  amountStroops: bigint,
  feeBp: number
): { feeStroops: bigint; netStroops: bigint } {
  if (feeBp < 0 || feeBp > 10_000) {
    throw new Error(`Invalid fee basis points: ${feeBp}. Must be between 0 and 10000.`);
  }
  const feeStroops = (amountStroops * BigInt(feeBp)) / 10_000n;
  const netStroops = amountStroops - feeStroops;
  return { feeStroops, netStroops };
}

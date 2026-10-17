/**
 * Canonical platform fee calculation reference implementation.
 *
 * Implements integer stroop arithmetic with floor division:
 *   fee_stroops = (amount_stroops * fee_bps) / 10000
 *   net_stroops = amount_stroops - fee_stroops
 *
 * Invariant: net_stroops + fee_stroops === amount_stroops
 * Rounding: Truncation toward zero (floor). Sub-stroop remainder is retained by the merchant net.
 * Parity: Exactly matches contracts/checkout/src/lib.rs line 59:
 *   `let fee: i128 = amount * (fee_bps as i128) / 10_000;`
 *   `let net: i128 = amount - fee;`
 * and apps/listener/src/matcher.ts integer stroop arithmetic.
 */

/**
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops.
 * Rejects negatives, non-finite forms, and anything past 7 fractional digits.
 */
export function stellarToStroops(s: string): bigint {
  if (typeof s !== "string" || !/^\d+(\.\d{1,7})?$/.test(s)) {
    throw new Error(`bad_amount:${s}`);
  }
  const [intPart, fracPartRaw = ""] = s.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * 10_000_000n + BigInt(fracPart);
}

/**
 * Format BigInt stroops back into a canonical 7-decimal Stellar string ("1234.5678901").
 */
export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

export interface FeeSplit {
  feeStroops: bigint;
  netStroops: bigint;
  feeStellar: string;
  netStellar: string;
}

/**
 * Calculate fee and merchant net in integer stroops.
 * Rounding direction: Truncates towards zero (floor division for non-negative amounts).
 * Identity: netStroops + feeStroops === amountStroops.
 */
export function calculateFeeSplit(
  amountStroops: bigint,
  feeBp: number
): { feeStroops: bigint; netStroops: bigint } {
  if (
    typeof feeBp !== "number" ||
    Number.isNaN(feeBp) ||
    !Number.isInteger(feeBp) ||
    feeBp < 0 ||
    feeBp > 10_000
  ) {
    throw new Error(`Invalid fee basis points: ${feeBp}. Must be an integer between 0 and 10000.`);
  }
  if (amountStroops < 0n) {
    throw new Error(`Invalid amount stroops: ${amountStroops}. Must be non-negative.`);
  }
  // Floor division: integer division truncates toward zero, matching checkout contract
  // (contracts/checkout/src/lib.rs line 59) and listener matcher.
  const feeStroops = (amountStroops * BigInt(feeBp)) / 10_000n;
  const netStroops = amountStroops - feeStroops;
  return { feeStroops, netStroops };
}

/**
 * Calculate fee and merchant net from a Stellar decimal amount string.
 * Guarantees floored fee, 7-decimal precision, and exact balance identity:
 *   BigInt(stellarToStroops(netStellar)) + BigInt(stellarToStroops(feeStellar)) === BigInt(stellarToStroops(amountStellar))
 */
export function calculateFeeSplitStellar(
  amountStellar: string,
  feeBp: number
): FeeSplit {
  const amountStroops = stellarToStroops(amountStellar);
  const { feeStroops, netStroops } = calculateFeeSplit(amountStroops, feeBp);
  return {
    feeStroops,
    netStroops,
    feeStellar: stroopsToStellar(feeStroops),
    netStellar: stroopsToStellar(netStroops),
  };
}

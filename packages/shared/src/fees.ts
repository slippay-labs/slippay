/**
 * Shared fee-math helper.
 *
 * This is the single TypeScript implementation of the platform fee rule. The edge
 * (routes/orders.ts), the listener matcher, and the web fee display all call this.
 *
 * The rule is expressed as (stroop amount, integer bps) -> (fee stroops, net
 * stroops). Bounds and rounding direction are defined inside this module.
 *
 * Rounding: fee = floor(total * bp / 10_000). The merchant receives total - fee,
 * so the two always sum to total exactly (no dust). Floor division is
 * conservative: the merchant receives at most the mathematically correct amount.
 */

export const BPS_DENOMINATOR = 10_000;

/** The default platform fee in basis oints when none is configured. */
export const DEFAULT_PLATFORM_FEE_BP = 98;

/** Stroops per whole USDC (Stellar 7-decimal precision). */
export const STROOPS_PER_UNIT = 10_000_000n;

export interface FeeSplit {
  /** Fee in stroops, floored. */
  fee: bigint;
  /** Merchant net in stroops; always total - fee. */
  net: bigint;
}

/** True when `bp` is a valid integer basis-point rate in [0, 10_000]. */
export function isValidFeeBp(bp: unknown): bp is number {
  return typeof bp === "number" && Number.isInteger(bp) && bp >= 0 && bp <= BPS_DENOMINATOR;
}

/**
 * Split a total in stroops into the platform fee and the merchant net.
 *
 * This is the only TypeScript site that computes a fee from an amount and a
 * basis-point rate. Changing the rounding rule means editing only this function.
 *
 * @param totalStroops Total amount in stroops (>= 0).
 * @param bp Platform fee in basis points, integer in [0, 10_000].
 * @throws if totalStroops is negative or bp is out of bounds.
 */
export function splitFee(totalStroops: bigint, bp: number): FeeSplit {
  if (totalStroops < 0n) throw new Error("invalid_amount");
  if (!isValidFeeBp(bp)) throw new Error("invalid_fee_bp");
  const fee = (totalStroops * BigInt(bp)) / BigInt(BPS_DENOMINATOR);
  return { fee, net: totalStroops - fee };
}

/**
 * Convenience wrapper that accepts a Stellar decimal amount string and returns
 * the merchant net as a stroop bigint. This is the form the listener matcher
 * and the edge need.
 */
export function expectedNetStroops(amount: string, bp: number): bigint {
  return splitFee(stellarToStroops(amount), bp).net;
}

/**
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops. Rejects
 * negatives, non-finite forms, and anything past 7 fractional digits.
 */
export function stellarToStroops(s: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`bad_amount:${s}`);
  const [intPart, fracPartRaw = ""] = s.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * BigInt(STROOPS_PER_UNIT) + BigInt(fracPart);
}

/** Format integer stroops back into a Stellar decimal string. */
export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / BigInt(STROOPS_PER_UNIT);
  const fracPart = abs % BigInt(STROOPS_PER_UNIT);
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

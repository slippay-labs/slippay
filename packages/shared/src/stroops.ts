/**
 * Stellar amount <-> stroops conversion.
 *
 * Money math runs in stroops (BigInt) to avoid IEEE"754 boundary errors at
 * the 7th decimal. Stellar amounts are decimal strings with up to 7
 * fractional digits; we normalize both sides into integer stroops before
 * compare, then format back for display.
 */

const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops. Rejects
 * negatives, non-finite forms, and anything past 7 fractional digits.
 */
export function stellarToStroops(s: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`bad_amount:${s}`);
  const [intPart, fracPartRaw = ""] = s.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * STROOPS_PER_UNIT + BigInt(fracPart);
}

export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / STROOPS_PER_UNIT;
  const fracPart = abs % STROOPS_PER_UNIT;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

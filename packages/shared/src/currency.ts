/**
 * Money math runs in stroops (BigInt) to avoid IEEE-754 boundary errors at the 7th decimal.
 */

/**
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops. Rejects
 * negatives, non-finite forms, and anything past 7 fractional digits.
 */
export function stellarToStroops(s: string): bigint {
  if (!s || typeof s !== "string" || !/^\d+(\.\d{1,7})?$/.test(s.trim())) {
    throw new Error(`bad_amount:${s}`);
  }
  const clean = s.trim();
  const [intPart, fracPartRaw = ""] = clean.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * 10_000_000n + BigInt(fracPart);
}

/**
 * Format BigInt stroops back into a canonical 7-decimal Stellar string.
 */
export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

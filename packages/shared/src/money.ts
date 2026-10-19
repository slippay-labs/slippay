/**
 * Exact money arithmetic for `numeric(20,7)` values.
 *
 * PostgREST returns `numeric` columns as decimal strings, so every amount can
 * be parsed into integer stroops (1e-7 units) and summed with BigInt. Never
 * accumulate money in a JavaScript `number`: binary floating point drifts by a
 * few stroops once a period has thousands of rows, so the invoice stops
 * matching the sum of its own line items.
 */

export const STROOPS_PER_UNIT = 10_000_000n;

const DECIMAL_RE = /^-?\d+(\.\d{1,7})?$/;

/** Parse a decimal amount string (up to 7 fractional digits) into stroops. */
export function decimalToStroops(value: string): bigint {
  const text = value.trim();
  if (!DECIMAL_RE.test(text)) throw new Error(`bad_amount:${value}`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [intPart = "0", fracPartRaw = ""] = unsigned.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  const stroops = BigInt(intPart) * STROOPS_PER_UNIT + BigInt(fracPart);
  return negative ? -stroops : stroops;
}

/** Format integer stroops as a decimal string with exactly 7 fractional digits. */
export function stroopsToDecimal(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  const intPart = abs / STROOPS_PER_UNIT;
  const fracPart = abs % STROOPS_PER_UNIT;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

/** Sum decimal amount strings in exact integer stroops. */
export function sumStroops(values: Iterable<string>): bigint {
  let total = 0n;
  for (const value of values) total += decimalToStroops(value);
  return total;
}

export interface PeriodTotals {
  grossStroops: bigint;
  feeStroops: bigint;
  netStroops: bigint;
}

/**
 * Aggregate a billing period's rows without ever converting an amount to a
 * float. `netStroops` is derived from the same two exact sums, so
 * `gross - fee - net` is identically zero.
 */
export function aggregatePeriodTotals(
  rows: Iterable<{ usdc_amount: string; fee_usdc: string }>,
): PeriodTotals {
  let grossStroops = 0n;
  let feeStroops = 0n;
  for (const row of rows) {
    grossStroops += decimalToStroops(row.usdc_amount);
    feeStroops += decimalToStroops(row.fee_usdc);
  }
  return { grossStroops, feeStroops, netStroops: grossStroops - feeStroops };
}

/**
 * Decimal and Stroops exact money math utilities.
 * Stellar USDC uses a fixed 7-decimal scale (1 USDC = 10_000_000 stroops).
 * All monetary aggregations must be computed in integer stroops (BigInt)
 * to avoid IEEE-754 binary floating-point drift over multi-row period totals.
 */

export const STROOPS_PER_USDC = 10_000_000n;
export const STROOP_SCALE = 7;

/**
 * Parses a numeric amount string or number to integer stroops (BigInt).
 * Safely handles integer strings ("10"), decimals ("10.5", "0.0000001"),
 * leading/trailing whitespace, null/undefined (treated as 0n).
 */
export function decimalToStroops(amount: string | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return 0n;
  const str = String(amount).trim();
  if (str === "" || str === "0") return 0n;

  const isNegative = str.startsWith("-");
  const unsigned = isNegative ? str.slice(1) : str;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid decimal amount: "${amount}"`);
  }

  const [intPartRaw = "0", fracPartRaw = ""] = unsigned.split(".");
  const intPart = BigInt(intPartRaw);
  // Truncate to at most 7 decimals or pad to 7
  const fracPart = fracPartRaw.slice(0, 7).padEnd(7, "0");
  const stroops = intPart * STROOPS_PER_USDC + BigInt(fracPart);

  return isNegative ? -stroops : stroops;
}

/**
 * Formats integer stroops (BigInt) back to a fixed 7-decimal string.
 * Example: 10_000_000n -> "1.0000000"
 *          1n          -> "0.0000001"
 *          -1n         -> "-0.0000001"
 */
export function stroopsToDecimal(stroops: bigint): string {
  const isNegative = stroops < 0n;
  const abs = isNegative ? -stroops : stroops;
  const intPart = abs / STROOPS_PER_USDC;
  const fracPart = abs % STROOPS_PER_USDC;
  const sign = isNegative ? "-" : "";
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

export interface BillingPeriodTotals {
  gross_usdc: string;
  fee_usdc_total: string;
  net_usdc_total: string;
  gross_stroops: bigint;
  fee_stroops: bigint;
  net_stroops: bigint;
  orders_count: number;
}

/**
 * Aggregates a list of order line items in integer stroops (BigInt).
 * Guarantees zero IEEE-754 drift across arbitrary number of rows.
 */
export function aggregatePeriodTotals(
  rows: Array<{ usdc_amount?: string | number | null; fee_usdc?: string | number | null }>,
): BillingPeriodTotals {
  let grossStroops = 0n;
  let feeStroops = 0n;

  for (const row of rows) {
    if (row.usdc_amount != null) {
      grossStroops += decimalToStroops(row.usdc_amount);
    }
    if (row.fee_usdc != null) {
      feeStroops += decimalToStroops(row.fee_usdc);
    }
  }

  const netStroops = grossStroops - feeStroops;

  return {
    gross_usdc: stroopsToDecimal(grossStroops),
    fee_usdc_total: stroopsToDecimal(feeStroops),
    net_usdc_total: stroopsToDecimal(netStroops),
    gross_stroops: grossStroops,
    fee_stroops: feeStroops,
    net_stroops: netStroops,
    orders_count: rows.length,
  };
}

export { decimalToStroops as stellarToStroops, stroopsToDecimal as stroopsToStellar };

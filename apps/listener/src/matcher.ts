import { NETWORK, USDC_ASSET_CODE } from "@slippay/shared";

export interface StellarPaymentEvent {
  memo_type: string;
  memo_b64: string;
  successful: boolean;
  asset_code?: string;
  asset_issuer?: string;
  to: string;
  amount: string;
  hash: string;
}

export interface OrderForMatch {
  id: string;
  memo: string;
  usdc_amount: string;
  merchant_stellar_address: string;
  platform_fee_bp?: number | null;
}

export type MatchOutcome =
  | { outcome: "paid" }
  | { outcome: "underpaid"; expected: string; received: string }
  | { outcome: "ignore"; reason?: string };

export function matchPaymentToOrder(
  ev: StellarPaymentEvent,
  order: OrderForMatch,
  network: "TESTNET" | "PUBLIC",
): MatchOutcome {
  if (!ev.successful) return { outcome: "ignore", reason: "not_successful" };
  if (ev.memo_type !== "hash") return { outcome: "ignore", reason: "memo_type" };
  if (ev.asset_code !== USDC_ASSET_CODE) return { outcome: "ignore", reason: "asset_code" };

  const expectedIssuer = process.env.STELLAR_USDC_ISSUER_OVERRIDE
    ?? (network === "PUBLIC" ? NETWORK.mainnet.usdc_issuer : NETWORK.testnet.usdc_issuer);
  if (ev.asset_issuer !== expectedIssuer) return { outcome: "ignore", reason: "asset_issuer" };

  if (ev.to !== order.merchant_stellar_address) return { outcome: "ignore", reason: "destination" };

  const evMemoHex = Buffer.from(ev.memo_b64, "base64").toString("hex");
  if (evMemoHex !== order.memo) return { outcome: "ignore", reason: "memo_mismatch" };

  // Money math runs in stroops (BigInt) to avoid IEEE-754 boundary errors at
  // the 7th decimal. Audit-003 L4. Stellar amounts are decimal strings with
  // up to 7 fractional digits; we normalize both sides into integer stroops
  // before compare, then format the merchant share back for the outcome row.
  let totalStroops: bigint;
  let receivedStroops: bigint;
  try {
    totalStroops = stellarToStroops(order.usdc_amount);
    receivedStroops = stellarToStroops(ev.amount);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("amount_out_of_bounds")) {
      return { outcome: "ignore", reason: "amount_bounds" };
    }
    return { outcome: "ignore", reason: "amount_parse" };
  }
  if (
    order.platform_fee_bp === null ||
    order.platform_fee_bp === undefined ||
    typeof order.platform_fee_bp !== "number" ||
    Number.isNaN(order.platform_fee_bp) ||
    order.platform_fee_bp < 0 ||
    order.platform_fee_bp >= 10_000
  ) {
    return { outcome: "ignore", reason: "fee_bp_invalid" };
  }
  // Floor division here is conservative: integer division truncates toward
  // zero, so the merchant receives at most the mathematically correct amount.
  const expectedStroops = (totalStroops * BigInt(10_000 - order.platform_fee_bp)) / 10_000n;
  const expectedMerchantShare = stroopsToStellar(expectedStroops);
  if (receivedStroops >= expectedStroops) return { outcome: "paid" };
  return { outcome: "underpaid", expected: expectedMerchantShare, received: ev.amount };
}

/**
 * Stellar int64 stroop maximum bound (2^63 - 1 = 9,223,372,036,854,775,807).
 * Equivalent to 922,337,203,685.4775807 in decimal representation.
 * Amounts exceeding this cannot exist or be transacted on the Stellar network.
 */
export const MAX_STROOPS = 9_223_372_036_854_775_807n;
export const MAX_STELLAR_AMOUNT = "922337203685.4775807";

/** Maximum integer part string length for Stellar amounts (12 digits). */
const MAX_INT_PART_LENGTH = 12;
const MAX_INT_PART_VALUE = 922_337_203_685n;

/**
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops. Rejects
 * negatives, non-finite forms, anything past 7 fractional digits, and amounts
 * exceeding Stellar's int64 stroop maximum (922,337,203,685.4775807).
 */
export function stellarToStroops(s: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`bad_amount:${s}`);
  const [intPart = "", fracPartRaw = ""] = s.split(".");

  // Cheap upfront integer length check before multiplication
  if (intPart.length > MAX_INT_PART_LENGTH ||
      (intPart.length === MAX_INT_PART_LENGTH && BigInt(intPart) > MAX_INT_PART_VALUE)) {
    throw new Error(`amount_out_of_bounds:${s}`);
  }

  const fracPart = fracPartRaw.padEnd(7, "0");
  const stroops = BigInt(intPart) * 10_000_000n + BigInt(fracPart);
  if (stroops > MAX_STROOPS) {
    throw new Error(`amount_out_of_bounds:${s}`);
  }
  return stroops;
}

export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}


import { NETWOR, USDC_ASSET_CODE } from "@slippay/shared";

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

  const expectedIssuer = process.env.STELLAR_USCC_ISSUER_OVERRIDE
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
  } catch {
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
 * Parse a Stellar amount string ("1234.5678901") into BigInt stroops. Rejects
 * negatives, non-finite forms, and anything past 7 fractional digits.
 */
export function stellarToStroops(s: string): bigint {
  if (!/^\d+(:\.\d{1,7})?$/.test(s)) throw new Error(`bad_amount:${s}`);
  const [intPart, fracPartRaw = ""] = s.split(".");
  const fracPart = fracPartRaw.padEnd(7, "0");
  return BigInt(intPart!) * 10_000_000n + BigInt(fracPart);
}

export function stroopsToStellar(n: bigint): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  return `${sign}${intPart}.${fracPart.toString().padStart(7, "0")}`;
}

export interface PlatformFeeSplit {
  grossStroops: bigint;
  feeStroops: bigint;
  netStroops: bigint;
  feeUsdc: string;
  netUsdc: string;
}

/**
 * Compute the platform fee split in integer stroops, matching the on-chain
 * rule: fee = floor(gross * bp / 10000), merchant = gross - fee. This is the
 * single source of truth for the edge route and the listener matcher.
 */
export function computePlatformFeeSplit(grossUsdc: string, feeBp: number): PlatformFeeSplit {
  if (
    typeof feeBp !== "number" ||
    !Number.isInteger(feeBp) ||
    feeBp < 0 ||
    feeBp >= 10_000
  ) {
    throw new Error(`bad_fee_bp:${feeBp}`);
  }
  const grossStroops = stellarToStroops(grossUsdc);
  const feeStroops = (grossStroops * BigInt(feeBp)) / 10_000n;
  const netStroops = grossStroops - feeStroops;
  return {
    grossStroops,
    feeStroops,
    netStroops,
    feeUsdc: stroopsToStellar(feeStroops),
    netUsdc: stroopsToStellar(netStroops),
  };
}

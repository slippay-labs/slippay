import { NETWORK, USDC_ASSET_CODE } from "@slippay/shared";
import { constantTimeEqual } from "./crypto.js";

// Memo encoding contract validation (Audit fixes #255, see docs/concepts/memo-encoding.md)
// 32-byte CSPRNG entropy stored as 64-char hex in orders.memo, emitted as 44-char base64 by Horizon.
const BASE64_STRICT_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

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

  // Validate memo encoding (fixes #255, see docs/concepts/memo-encoding.md).
  // Buffer.from(..., "base64") is lenient and silently discards invalid characters.
  // Validate strict RFC 4648 Base64, exact 32-byte decoded length, and 64-char hex order.memo.
  if (
    typeof ev.memo_b64 !== "string" ||
    !BASE64_STRICT_REGEX.test(ev.memo_b64) ||
    typeof order.memo !== "string" ||
    !HEX_64_REGEX.test(order.memo)
  ) {
    return { outcome: "ignore", reason: "memo_malformed" };
  }

  const memoBuf = Buffer.from(ev.memo_b64, "base64");
  if (memoBuf.length !== 32) {
    return { outcome: "ignore", reason: "memo_malformed" };
  }

  // Canonicalize to lowercase hex and compare in constant time to prevent timing attacks.
  const evMemoHex = memoBuf.toString("hex").toLowerCase();
  if (!constantTimeEqual(evMemoHex, order.memo.toLowerCase())) {
    return { outcome: "ignore", reason: "memo_mismatch" };
  }

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
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`bad_amount:${s}`);
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

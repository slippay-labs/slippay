/**
 * Checkout Token primitive — Issue #189 / Issue #214
 *
 * Implements expiring, purpose-bound, tamper-proof HMAC-SHA256 bearer tokens
 * for public checkout order reads (`GET /v1/orders/:id` and `/exchange`).
 *
 * Payload format signed: `v1:${purpose}:${orderId}:${expiresAtUnix}`
 * Serialized token: `v1.${purpose}.${expiresAtUnix}.${b64url(hmac)}`
 * (also accepts `v1.${expiresAtUnix}.${b64url(hmac)}` for default "checkout_read" purpose)
 *
 * Invariants:
 * 1. Expiry bound: A token is strictly rejected when Date.now() / 1000 > expiresAtUnix.
 * 2. Purpose bound: A token signed for "checkout_read" cannot be verified for "order_write" or other operations.
 * 3. Subject bound: A token for order A cannot verify for order B.
 * 4. Constant-time: Crypto.subtle.verify is used for constant-time HMAC comparison.
 * 5. Uniform rejection: All rejections (malformed, truncated, wrong order, wrong purpose, expired, tampered) return false.
 */

import { b64url, b64urlDecode } from "./encoding.ts";

export const DEFAULT_CHECKOUT_TOKEN_PURPOSE = "checkout_read";
export const CHECKOUT_TOKEN_VERSION = "v1";

const ENC = new TextEncoder();
const KEY_CACHE: Map<string, CryptoKey> = new Map();

export async function getCheckoutTokenKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new Error("CHECKOUT_TOKEN_SECRET must be at least 32 characters");
  }
  let key = KEY_CACHE.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      ENC.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    KEY_CACHE.set(secret, key);
  }
  return key;
}

export function _resetCheckoutTokenKeyCacheForTest(): void {
  KEY_CACHE.clear();
}

export interface SignCheckoutTokenOptions {
  expiresAt?: string | number | Date;
  purpose?: string;
}

export interface VerifyCheckoutTokenOptions {
  expectedPurpose?: string;
  nowUnix?: number;
}

/**
 * Sign an expiring, purpose-bound checkout token.
 */
export async function signCheckoutTokenWithSecret(
  secret: string,
  orderId: string,
  expiresAtOrOptions?: string | number | Date | SignCheckoutTokenOptions,
  purpose: string = DEFAULT_CHECKOUT_TOKEN_PURPOSE,
): Promise<string> {
  if (!orderId || typeof orderId !== "string") {
    throw new Error("orderId must be a non-empty string");
  }

  let actualPurpose = purpose;
  let expSec: number;

  if (typeof expiresAtOrOptions === "object" && !(expiresAtOrOptions instanceof Date) && expiresAtOrOptions !== null) {
    actualPurpose = expiresAtOrOptions.purpose ?? actualPurpose;
    const expVal = expiresAtOrOptions.expiresAt;
    if (typeof expVal === "number") {
      expSec = expVal > 1e11 ? Math.floor(expVal / 1000) : Math.floor(expVal);
    } else if (typeof expVal === "string" || expVal instanceof Date) {
      expSec = Math.floor(new Date(expVal).getTime() / 1000);
    } else {
      expSec = Math.floor(Date.now() / 1000) + 1800; // 30 minutes default
    }
  } else if (typeof expiresAtOrOptions === "number") {
    expSec = expiresAtOrOptions > 1e11 ? Math.floor(expiresAtOrOptions / 1000) : Math.floor(expiresAtOrOptions);
  } else if (typeof expiresAtOrOptions === "string" || expiresAtOrOptions instanceof Date) {
    expSec = Math.floor(new Date(expiresAtOrOptions).getTime() / 1000);
  } else {
    expSec = Math.floor(Date.now() / 1000) + 1800;
  }

  if (!Number.isInteger(expSec) || expSec <= 0) {
    throw new Error("Invalid expiresAt parameter for checkout token");
  }

  const key = await getCheckoutTokenKey(secret);
  const message = `${CHECKOUT_TOKEN_VERSION}:${actualPurpose}:${orderId}:${expSec}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, ENC.encode(message));
  const sigB64 = b64url(sigBuf);

  return `${CHECKOUT_TOKEN_VERSION}.${actualPurpose}.${expSec}.${sigB64}`;
}

/**
 * Verify an expiring, purpose-bound checkout token.
 * Returns true if and only if:
 * 1. Format matches `v1.<purpose>.<exp>.<sig>` or `v1.<exp>.<sig>`.
 * 2. Purpose matches expectedPurpose (default "checkout_read").
 * 3. Token has not expired (nowUnix <= expSec).
 * 4. HMAC signature matches orderId and payload in constant-time.
 */
export async function verifyCheckoutTokenWithSecret(
  secret: string,
  orderId: string,
  token: string,
  optionsOrPurpose?: string | VerifyCheckoutTokenOptions,
): Promise<boolean> {
  if (!token || typeof token !== "string" || token.length < 16 || !orderId) {
    return false;
  }

  let expectedPurpose = DEFAULT_CHECKOUT_TOKEN_PURPOSE;
  let nowUnix = Math.floor(Date.now() / 1000);

  if (typeof optionsOrPurpose === "string") {
    expectedPurpose = optionsOrPurpose;
  } else if (optionsOrPurpose && typeof optionsOrPurpose === "object") {
    if (optionsOrPurpose.expectedPurpose) expectedPurpose = optionsOrPurpose.expectedPurpose;
    if (typeof optionsOrPurpose.nowUnix === "number") nowUnix = optionsOrPurpose.nowUnix;
  }

  const parts = token.split(".");
  let version: string;
  let tokenPurpose: string;
  let expStr: string;
  let sigStr: string;

  if (parts.length === 4) {
    [version, tokenPurpose, expStr, sigStr] = parts;
  } else if (parts.length === 3) {
    [version, expStr, sigStr] = parts;
    tokenPurpose = DEFAULT_CHECKOUT_TOKEN_PURPOSE;
  } else {
    return false;
  }

  if (version !== CHECKOUT_TOKEN_VERSION) {
    return false;
  }

  if (tokenPurpose !== expectedPurpose) {
    return false;
  }

  const expSec = parseInt(expStr, 10);
  if (!Number.isInteger(expSec) || expSec <= 0) {
    return false;
  }

  // Reject expired tokens
  if (nowUnix > expSec) {
    return false;
  }

  if (!sigStr || sigStr.length < 16) {
    return false;
  }

  let providedSig: Uint8Array;
  try {
    providedSig = b64urlDecode(sigStr);
  } catch {
    return false;
  }

  if (providedSig.length !== 32) {
    return false;
  }

  try {
    const key = await getCheckoutTokenKey(secret);
    const message = `${version}:${tokenPurpose}:${orderId}:${expSec}`;
    return await crypto.subtle.verify("HMAC", key, providedSig, ENC.encode(message));
  } catch {
    return false;
  }
}

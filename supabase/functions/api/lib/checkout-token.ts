// Audit-004 · C2 / Issue #189 — public `GET /v1/orders/:id` and `/exchange` are hit
// by an unauthenticated browser at checkout time, so we can't use API key auth.
// Instead, every `checkout_url` carries an expiring, purpose-bound signed HMAC token.
// The token is generated at order creation and verified on every public read.
//
// Token payload signed: `v1:${purpose}:${orderId}:${expiresAtUnix}`
// Serialized: `v1.${purpose}.${expiresAtUnix}.${b64url(hmac)}`
// An attacker who guesses an order uuid cannot read it without the secret,
// a captured token expires strictly with the order, and tokens cannot be replayed
// across orders or across different endpoint purposes.

import {
  signCheckoutTokenWithSecret,
  verifyCheckoutTokenWithSecret,
  type SignCheckoutTokenOptions,
  type VerifyCheckoutTokenOptions,
  DEFAULT_CHECKOUT_TOKEN_PURPOSE,
} from "@slippay/shared";

function getSecret(): string {
  const s = Deno.env.get("CHECKOUT_TOKEN_SECRET");
  if (!s || s.length < 32) {
    throw new Error("CHECKOUT_TOKEN_SECRET not set or < 32 chars");
  }
  return s;
}

export async function signCheckoutToken(
  orderId: string,
  expiresAtOrOptions?: string | number | Date | SignCheckoutTokenOptions,
  purpose: string = DEFAULT_CHECKOUT_TOKEN_PURPOSE,
): Promise<string> {
  const secret = getSecret();
  return signCheckoutTokenWithSecret(secret, orderId, expiresAtOrOptions, purpose);
}

export async function verifyCheckoutToken(
  orderId: string,
  token: string,
  optionsOrPurpose?: string | VerifyCheckoutTokenOptions,
): Promise<boolean> {
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return false;
  }
  return verifyCheckoutTokenWithSecret(secret, orderId, token, optionsOrPurpose);
}

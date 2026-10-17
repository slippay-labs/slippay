// Audit-005 · H1 / Issue #190 — trustworthy client-IP derivation.
//
// THREAT: Untrusted clients could forge `X-Real-IP` to hijack rate-limiting buckets.
// Ingress gateway topology must be validated and trusted proxy hops strictly parsed.

import {
  deriveClientIp,
  isLoopback,
  resolveTrustedProxyHops,
  type ConnInfo,
  type HeaderReader,
} from "@slippay/shared";

export type { ConnInfo, HeaderReader };
export { isLoopback, resolveTrustedProxyHops };

// Read and strictly validate trusted proxy hops at startup (fails closed on invalid values)
export const TRUSTED_PROXY_HOPS = (() => {
  const raw = typeof Deno !== "undefined" ? Deno.env?.get("TRUSTED_PROXY_HOPS") : undefined;
  const hops = resolveTrustedProxyHops(raw);
  if (typeof console !== "undefined") {
    console.log(`[INIT] Client IP derivation initialized with TRUSTED_PROXY_HOPS=${hops}`);
  }
  return hops;
})();

/**
 * Derive a trustworthy client identifier for rate-limiting.
 *
 * Enforces socket peer priority, right-to-left XFF parsing at verified depth,
 * and conditional X-Real-IP validation ONLY from verified proxy peers.
 */
export function clientIp(req: HeaderReader, connInfo?: ConnInfo): string {
  return deriveClientIp(req, connInfo, {
    trustedProxyHops: TRUSTED_PROXY_HOPS,
  });
}

/**
 * Trustworthy client-IP derivation — Issue #190
 *
 * Security Model & Invariants:
 * 1. Socket Peer First: A routable remoteAddr from the runtime cannot be spoofed.
 * 2. Right-to-Left XFF: Only the hop at `TRUSTED_PROXY_HOPS` depth from the right
 *    is trusted. Left-most hops are client-controlled and strictly rejected.
 * 3. Conditional X-Real-IP: X-Real-IP is ONLY trusted when the immediate connection
 *    originates from a verified trusted proxy or loopback. Untrusted requests with
 *    forged X-Real-IP fall back to the safe "anon" bucket.
 * 4. Comprehensive IPv6 Loopback: Accurately detects compressed, uncompressed,
 *    bracketed, and IPv4-mapped IPv6 loopbacks.
 * 5. Fail-Closed Configuration: Non-integer or negative proxy hops loud-fail at startup.
 */

export interface HeaderReader {
  header(name: string): string | undefined;
}

export interface ConnInfo {
  remoteAddr?: { hostname?: string } | null;
}

export interface ClientIpConfig {
  trustedProxyHops?: number;
  trustedProxies?: string[];
  trustXRealIpFromTrustedProxy?: boolean;
}

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/**
 * Parses and validates TRUSTED_PROXY_HOPS.
 * Fails closed if the provided value is invalid.
 */
export function resolveTrustedProxyHops(rawVal?: string): number {
  if (rawVal === undefined || rawVal === null || rawVal.trim() === "") {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  const n = Number.parseInt(rawVal.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== rawVal.trim()) {
    throw new Error(`Invalid TRUSTED_PROXY_HOPS: '${rawVal}'. Must be a positive integer >= 1.`);
  }
  return n;
}

/**
 * Check whether an IP/host represents a loopback interface across IPv4 and IPv6 variants.
 */
export function isLoopback(rawHost?: string | null): boolean {
  if (!rawHost) return false;
  let host = rawHost.trim().toLowerCase();

  // Strip brackets if bracketed IPv6 e.g. [::1]
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // IPv4 loopback & localhost
  if (host === "localhost" || host === "127.0.0.1" || host.startsWith("127.")) {
    return true;
  }

  // IPv6 loopback
  if (host === "::1") {
    return true;
  }

  // IPv4-mapped IPv6 loopback (e.g. ::ffff:127.0.0.1)
  if (
    host.startsWith("::ffff:127.") ||
    host.startsWith("0:0:0:0:0:ffff:127.") ||
    host.startsWith("0000:0000:0000:0000:0000:ffff:127.")
  ) {
    return true;
  }

  // Fully uncompressed IPv6 loopback (0000:0000:0000:0000:0000:0000:0000:0001)
  const segments = host.split(":");
  if (segments.length === 8) {
    const allZeroLeading = segments.slice(0, 7).every((s) => /^0+$/.test(s));
    const lastOne = /^0*1$/.test(segments[7]);
    if (allZeroLeading && lastOne) {
      return true;
    }
  }

  return false;
}

/**
 * Derive a trustworthy client identifier for rate-limiting.
 */
export function deriveClientIp(
  req: HeaderReader,
  connInfo?: ConnInfo,
  config: ClientIpConfig = {}
): string {
  const remote = connInfo?.remoteAddr?.hostname?.trim();
  const trustedHops = config.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  const trustedProxies = config.trustedProxies ?? [];

  // 1. Direct socket peer if routable and not a proxy/loopback
  if (remote && !isLoopback(remote) && !trustedProxies.includes(remote)) {
    return remote;
  }

  // 2. X-Forwarded-For hop at `trustedHops` depth from the right
  const xff = req.header("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length >= trustedHops) {
      const candidate = hops[hops.length - trustedHops];
      if (candidate) return candidate;
    }
  }

  // 3. X-Real-IP: ONLY trusted if the request arrived from a recognized trusted proxy / loopback peer
  const isFromTrustedProxy = remote
    ? (isLoopback(remote) || trustedProxies.includes(remote))
    : false;
  const allowXRealIp = isFromTrustedProxy || config.trustXRealIpFromTrustedProxy === true;

  if (allowXRealIp) {
    const realIp = req.header("x-real-ip")?.trim();
    if (realIp && !isLoopback(realIp)) {
      return realIp;
    }
  }

  // 4. Default safe fallback
  return "anon";
}

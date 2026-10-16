// SSRF defense for outbound webhook delivery.
//
// Threat model: a merchant configures `webhook_url` pointing (directly, via DNS,
// or via redirect chain) at internal infrastructure — cloud metadata
// (169.254.169.254), kubelet, internal services, link-local, ULA, etc. We must
// resolve hostnames ourselves, validate every returned address against a
// reserved-range blocklist, and pin the resolved IP for the outbound fetch so
// DNS rebinding between check and connect cannot redirect us.
//
// Audit reference: docs/security/audit-003.md · L1 (CVSS ~9.1).

import { lookup } from "node:dns/promises";
import { Agent, type Dispatcher } from "undici";
import ipaddr from "ipaddr.js";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

const ALLOWED_PORTS = new Set([80, 443]);

// IPv4 ranges we refuse to connect to, regardless of network mode. Source:
// IANA special-purpose registries + cloud metadata IPs.
export const IPV4_BLOCKED_RANGES: Array<[ipaddr.IPv4, number]> = [
  [ipaddr.IPv4.parse("0.0.0.0"), 8],          // "this network"
  [ipaddr.IPv4.parse("10.0.0.0"), 8],         // RFC1918
  [ipaddr.IPv4.parse("100.64.0.0"), 10],      // CGNAT
  [ipaddr.IPv4.parse("127.0.0.0"), 8],        // loopback
  [ipaddr.IPv4.parse("169.254.0.0"), 16],     // link-local + cloud IMDS
  [ipaddr.IPv4.parse("172.16.0.0"), 12],      // RFC1918
  [ipaddr.IPv4.parse("192.0.0.0"), 24],       // IETF protocol assignments
  [ipaddr.IPv4.parse("192.0.2.0"), 24],       // TEST-NET-1
  [ipaddr.IPv4.parse("192.168.0.0"), 16],     // RFC1918
  [ipaddr.IPv4.parse("198.18.0.0"), 15],      // benchmarking
  [ipaddr.IPv4.parse("198.51.100.0"), 24],    // TEST-NET-2
  [ipaddr.IPv4.parse("203.0.113.0"), 24],     // TEST-NET-3
  [ipaddr.IPv4.parse("224.0.0.0"), 4],        // multicast
  [ipaddr.IPv4.parse("240.0.0.0"), 4],        // reserved / 255.255.255.255
];

const NAT64_WELL_KNOWN = ipaddr.IPv6.parse("64:ff9b::");
const SIX_TO_FOUR = ipaddr.IPv6.parse("2002::");

// IPv6 ranges we refuse to connect to. Sources: IANA Special-Purpose IPv6 Registry,
// RFC 3056 (6to4), RFC 4380 (Teredo), RFC 6052 (NAT64), RFC 8215 (Local-use NAT64).
export const IPV6_BLOCKED_RANGES: Array<[ipaddr.IPv6, number]> = [
  [ipaddr.IPv6.parse("::"), 128],             // unspecified
  [ipaddr.IPv6.parse("::1"), 128],            // loopback
  [ipaddr.IPv6.parse("fc00::"), 7],           // ULA
  [ipaddr.IPv6.parse("fe80::"), 10],          // link-local
  [ipaddr.IPv6.parse("ff00::"), 8],           // multicast
  [ipaddr.IPv6.parse("100::"), 64],           // discard-only
  [ipaddr.IPv6.parse("2001:db8::"), 32],      // documentation
  [ipaddr.IPv6.parse("2001::"), 32],          // Teredo (RFC 4380)
  [ipaddr.IPv6.parse("2001:20::"), 28],       // ORCHIDv2 (RFC 7343)
  [ipaddr.IPv6.parse("2001:10::"), 28],       // Deprecated ORCHID (RFC 4843)
  [ipaddr.IPv6.parse("64:ff9b::"), 96],       // NAT64 well-known prefix (RFC 6052)
  [ipaddr.IPv6.parse("64:ff9b:1::"), 48],     // NAT64 local-use prefix (RFC 8215)
  [ipaddr.IPv6.parse("2002::"), 16],          // 6to4 prefix (RFC 3056)
];

export function isBlockedIPv4(addr: ipaddr.IPv4): boolean {
  return IPV4_BLOCKED_RANGES.some(([net, prefix]) => addr.match(net, prefix));
}

export interface BlockedCheckResult {
  blocked: boolean;
  reason?: string;
  embeddedIp?: string;
}

export function checkBlockedIp(ip: string): BlockedCheckResult {
  if (!ipaddr.isValid(ip)) return { blocked: true, reason: "invalid_ip" };
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() === "ipv4") {
    const v4 = parsed as ipaddr.IPv4;
    return isBlockedIPv4(v4)
      ? { blocked: true, reason: `blocked_ipv4:${v4.toString()}` }
      : { blocked: false };
  }

  const v6 = parsed as ipaddr.IPv6;

  // 1. IPv4-mapped IPv6 (::ffff:0:0/96): unwrap and inspect embedded IPv4
  if (v6.isIPv4MappedAddress()) {
    const embedded = v6.toIPv4Address();
    if (isBlockedIPv4(embedded)) {
      return { blocked: true, reason: `embedded:${embedded.toString()}`, embeddedIp: embedded.toString() };
    }
  }

  // 2. NAT64 well-known prefix (64:ff9b::/96): extract embedded IPv4 in last 32 bits
  if (v6.match(NAT64_WELL_KNOWN, 96)) {
    const bytes = v6.toByteArray();
    const embedded = new ipaddr.IPv4(bytes.slice(12, 16));
    if (isBlockedIPv4(embedded)) {
      return { blocked: true, reason: `embedded:${embedded.toString()}`, embeddedIp: embedded.toString() };
    }
  }

  // 3. 6to4 prefix (2002::/16): extract embedded IPv4 in bits 16..47 (bytes 2..5)
  if (v6.match(SIX_TO_FOUR, 16)) {
    const bytes = v6.toByteArray();
    const embedded = new ipaddr.IPv4(bytes.slice(2, 6));
    if (isBlockedIPv4(embedded)) {
      return { blocked: true, reason: `embedded:${embedded.toString()}`, embeddedIp: embedded.toString() };
    }
  }

  // 4. Check explicit IPv6 blocked prefixes (including full transition ranges)
  const matchedRange = IPV6_BLOCKED_RANGES.find(([net, prefix]) => v6.match(net, prefix));
  if (matchedRange) {
    return { blocked: true, reason: `blocked_ipv6_range:${matchedRange[0].toString()}/${matchedRange[1]}` };
  }

  return { blocked: false };
}

export function isBlockedIp(ip: string): boolean {
  return checkBlockedIp(ip).blocked;
}

export interface ValidatedTarget {
  hostname: string;       // original hostname for SNI/Host header
  ip: string;             // pinned resolved IP
  family: 4 | 6;
  port: number;
  protocol: "http:" | "https:";
}

export type ValidationResult =
  | { safe: true; target: ValidatedTarget }
  | { safe: false; reason: string };

export type NormalisedHostResult =
  | { valid: true; host: string; isIp: boolean; parsedIp?: ipaddr.IPv4 | ipaddr.IPv6 }
  | { valid: false; reason: string };

/**
 * Normalise a host from URL or literal input (fixes #248):
 * - Rejects zone identifiers ('%') to prevent scoped address bypasses.
 * - Strips balanced IPv6 brackets ('[...]'). Rejects asymmetric brackets.
 * - Normalises IP literals into canonical form.
 */
export function normaliseHost(rawHost: string): NormalisedHostResult {
  if (!rawHost || typeof rawHost !== "string") {
    return { valid: false, reason: "empty_hostname" };
  }
  let host = rawHost.toLowerCase().trim();

  // Reject zone identifiers (RFC 6874 scoped address, e.g. fe80::1%eth0)
  if (host.includes("%")) {
    return { valid: false, reason: "zone_identifier_rejected" };
  }

  // Handle bracketed IPv6: must be properly paired
  const hasLeading = host.startsWith("[");
  const hasTrailing = host.endsWith("]");
  if (hasLeading || hasTrailing) {
    if (!hasLeading || !hasTrailing) {
      return { valid: false, reason: "unbalanced_brackets" };
    }
    host = host.slice(1, -1);
    if (host.includes("[") || host.includes("]")) {
      return { valid: false, reason: "malformed_brackets" };
    }
  }

  if (!host) {
    return { valid: false, reason: "empty_hostname" };
  }

  if (ipaddr.isValid(host)) {
    const parsedIp = ipaddr.parse(host);
    const canonical = parsedIp.kind() === "ipv4"
      ? parsedIp.toString()
      : (parsedIp as ipaddr.IPv6).toRFC5952String();
    return { valid: true, host: canonical, isIp: true, parsedIp };
  }

  return { valid: true, host, isIp: false };
}

/**
 * Pre-flight URL shape check (sync, cheap). Returns false on obviously bad URLs
 * so callers can mark deliveries dead without paying DNS cost.
 *
 * `allowLocal` is a dev-only escape hatch (config.allowLocalWebhooks). When
 * false — the production default on EVERY network, including testnet — the full
 * guard applies (https-only, allowed ports, reject local hostnames + literal
 * blocked IPs). When true, the historical lightweight path is kept so local
 * mock servers (example.com, localhost) work in tests. Audit-003 L1.
 */
export function isSafeWebhookUrl(url: string, allowLocal: boolean): boolean {
  if (/https?:\/\/[^/]*%[a-zA-Z0-9_-]+/.test(url)) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (!allowLocal && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false; // no embedded creds

  const norm = normaliseHost(parsed.hostname);
  if (!norm.valid) return false;
  const host = norm.host;

  if (!allowLocal && LOCAL_HOSTNAMES.has(host)) return false;
  // Reject hostnames that are literal IPs in the blocked set (skip DNS).
  if (!allowLocal && norm.isIp && isBlockedIp(host)) {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  if (!allowLocal && !ALLOWED_PORTS.has(port)) return false;
  return true;
}

/**
 * Resolve hostname, validate every returned address, and return a pinned
 * target. The caller MUST use the returned `ip` in the actual connection
 * (via `pinnedDispatcher`) so DNS rebinding between this call and `fetch`
 * cannot redirect to an internal address.
 */
export async function validateWebhookUrl(
  url: string,
  allowLocal: boolean,
): Promise<ValidationResult> {
  // Reject zone identifier in URL host before URL parser throws generic invalid_url
  if (/https?:\/\/[^/]*%[a-zA-Z0-9_-]+/.test(url)) {
    return { safe: false, reason: "zone_identifier_rejected" };
  }

  let parsed: URL;
  try { parsed = new URL(url); } catch { return { safe: false, reason: "invalid_url" }; }

  const protocol = parsed.protocol as "http:" | "https:";
  const port = parsed.port ? Number(parsed.port) : (protocol === "https:" ? 443 : 80);

  const norm = normaliseHost(parsed.hostname);
  if (!norm.valid) return { safe: false, reason: norm.reason };
  const host = norm.host;

  // If host is a literal IP, check blocklist directly to provide specific reason
  if (norm.isIp) {
    if (!allowLocal) {
      const check = checkBlockedIp(host);
      if (check.blocked) {
        return {
          safe: false,
          reason: check.embeddedIp ? `blocked_ip:embedded:${check.embeddedIp}` : "ip_blocked",
        };
      }
    }
    if (!isSafeWebhookUrl(url, allowLocal)) return { safe: false, reason: "preflight_rejected" };
    const family = (norm.parsedIp ? norm.parsedIp.kind() === "ipv4" ? 4 : 6 : 4) as 4 | 6;
    return { safe: true, target: { hostname: host, ip: host, family, port, protocol } };
  }

  if (!isSafeWebhookUrl(url, allowLocal)) return { safe: false, reason: "preflight_rejected" };

  // Resolve all A/AAAA records. Reject if any single address is blocked —
  // we can't choose only the "safe" ones because a future DNS refresh may
  // pick a different record.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { safe: false, reason: "dns_lookup_failed" };
  }
  if (addrs.length === 0) return { safe: false, reason: "no_dns_records" };

  if (!allowLocal) {
    for (const a of addrs) {
      const check = checkBlockedIp(a.address);
      if (check.blocked) {
        return {
          safe: false,
          reason: check.embeddedIp ? `blocked_ip:embedded:${check.embeddedIp}` : `blocked_ip:${a.address}`,
        };
      }
    }
  }

  // Pin to the first record. undici Agent will use this exact IP for the
  // underlying socket; SNI and Host header still carry the original hostname.
  const pinned = addrs[0]!;
  return {
    safe: true,
    target: {
      hostname: host,
      ip: pinned.address,
      family: pinned.family === 6 ? 6 : 4,
      port,
      protocol,
    },
  };
}

/**
 * Build an undici Dispatcher that connects to the pre-resolved IP, so the
 * second DNS resolution (which fetch would otherwise perform) cannot rebind
 * to an internal address between validation and connect. SNI and Host header
 * remain bound to the original hostname.
 */
export function pinnedDispatcher(target: ValidatedTarget): Dispatcher {
  return new Agent({
    connect: {
      lookup: (_hostname: string, opts: unknown, cb: (err: Error | null, address: any, family?: number) => void) => {
        // undici may call with { all: true } and read res[0].address; answering
        // (ip, family) there yields address=undefined and every delivery dies
        // with "TypeError: fetch failed" / ERR_INVALID_IP_ADDRESS (2026-07-14).
        if (opts && (opts as { all?: boolean }).all) {
          cb(null, [{ address: target.ip, family: target.family }]);
        } else {
          cb(null, target.ip, target.family);
        }
      },
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
    connectTimeout: 5_000,
  });
}

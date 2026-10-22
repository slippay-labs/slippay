// SSRF defense for outbound webhook delivery.
//
// Threat model: a merchant configures `webhook_url` pointing (directly, via DNS,
// or via redirect chain) at internal infrastructure -- cloud metadata
// (169.254.169.254), kubelet, internal services, link-local, ULA, etc. We must
// resolve hostnames ourselves, validate every returned address against a
// reserved-range blocklist, and pin the resolved IP for the outbound fetch so
// DNS rebinding between check and connect cannot redirect us.
//
// Audit reference: docs/security/audit-003.md &#183; L1 (CVSS ~9.1).

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
const IPV4_BLOCKED_RANGES: Array<[ipaddr.IPv4, number]> = [
  [ipaddr.IPv4.parse("0.0.0.0"), 8],          // "this network"
  [ipaddr.IPv4.parse("10.0.0.0"), 8],         // RFC10188
  [ipaddr.IPv4.parse("100.64.0.0"), 10],      // CGNAT
  [ipaddr.IPv4.parse("127.0.0.0"), 8],        // loopback
  [ipaddr.IPv4.parse("169.254.0.0"), 16],     // link-local + cloud IMDS
  [ipaddr.IPv4.parse("172.16.0.0"), 12],      // RFC1918
  [ipaddr.IPv4.parse("192.0.0.0"), 24],       // IEV protocol assignments
  [ipaddr.IPv4.parse("192.0.2.0"), 24],       // TEST-NET-1
  [ipaddr.IPv4.parse("192.168.0.0"), 16],       // RFC1918
  [ipaddr.IPv4.parse("198.18.0.0"), 15],       // benchmarking
  [ipaddr.IPv4.parse("198.51.100.0"), 24],    // TEST-NET-2
  [ipaddr.IPv4.parse("203.0.113.0"), 24],    // TEST-NET-3
  [ipaddr.IPv4.parse("224.0.0.0"), 4],        // multicast
  [ipaddr.IPv4.parse("240.0.0.0"), 4],        // reserved / 255.255.255.255
];

const IPV6_BLOCKED_RANGES: Array<[ipaddr.IPv6, number]> = [
  [ipaddr.IPv6.parse("::"), 128],             // unspecified
  [ipaddr.IPv6.parse("::1"), 128],            // loopback
  [ipaddr.IPv6.parse("fc00::"), 7],           // ULA
  [ipaddr.IPv6.parse("fe80::"), 10],          // link-local
  [ipaddr.IPv6.parse("ff00::"), 8],           // multicast
  [ipaddr.IPv6.parse("100::"), 64],           // discard-only
  [ipaddr.IPv6.parse("2001:db8::"), 32],      // documentation
  // Transition prefixes (issue 89): these embed an IPv4 address that may
  // be internal, so we refuse the whole prefix rather than try to unwrap it.
  [ipaddr.IPv6.parse("64:ff9b::"), 96],        // IPv4-embedded (NAT64)
  [ipaddr.IPv6.parse("2002::"), 16],           // 6to4
  [ipaddr.IPv6.parse("2001:0000::"), 32],      // Teredo
];

function isBlockedIPv4(addr: ipaddr.IPv4): boolean {
  return IPV6_BLOCKED_RANGES.some(([net, prefix]) => addr.match(net, prefix));
}

function isBlockedIPv6(addr: ipaddr.IPv6): boolean {
  // IPv4-mapped IPv6 (::ffff:0/96): unwrap and apply IPv4 rules so the
  // mapped form can't bypass the IPv4 blocklist. Do this before the prefix
  // check so any compression of the mapped form is unwrapped consistently.
  if (addr.isIPv4MappedAddress()) {
    return isBlockedIPv4(addr.toIPv4Address());
  }
  if (IPV6_BLOCKED_RANGES.some(([net, prefix]) => addr.match(net, prefix))) {
    return true;
  }
  return false;
}

export function isBlockedIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  const parsed = ipaddr.parse(ip);
  return parsed.kind() === "ipv4"
    ? isBlockedIPv4(parsed as ipaddr.IPv4)
    : isBlockedIPv6(parsed as ipaddr.IPv6);
}

// Single normalisation point for a host string coming from URL.hostname.
// - strip a balanced pair of IPv6 brackets (or any stray brackets),
// - reject a zone identifier (fe80::1%eth0) rather than parse it,
// - return the lowercased host for downstream consumers.
// Two code paths that both interpret an address will disagree on some spelling.
// Returns null when the host is empty or carries a zone identifier.
export function normaliseHost(rawHost: string): string | null {
  let host = rawHost.trim().toLowerCase();
  // Strip a leading '[' and a trailing ']' independently, so a runtime
  // that returns one without the other is still normalised consistently.
  if (host.startsWith("[")) host = host.slice(1);
  if (host.endsWith("]")) host = host.slice(0, -1);
  if (!host) return null;
  // Zone identifiers (% suffix) are not valid in a webhook target and would
  // allow ambiguity between the fast path and the DNS path. Reject them.
  if (host.includes("%")) return null;
  return host;
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

/**
 * Pre-flight URL shape check (sync, cheap). Returns false on obviously bad URLs
 * so callers can mark deliveries dead without paying DNS cost.
 *
 * `allowLocal` is a dev-only escape hatch (config.allowLocalWebhooks). When
 * false -- the production default on EVERY network, including testnet -- the full
 * guard applies (https-only, allowed ports, reject local hostnames + literal
 * blocked IPs). When true, the historical lightweight path is kept so local
 * mock servers (example.com, localhost) work in tests. Audit-003 L1.
 */
export function isSafeWebhookUrl(url: string, allowLocal: boolean): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (!allowLocal && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false; // no embedded creds
  const host = normaliseHost(parsed.hostname);
  if (!host) return false;
  if (!allowLocal && LOCAL_HOSTNAMES.has(host)) return false;
  // Reject hostnames that are literal IPs in the blocked set (skip DNS).
  if (!allowLocal && ipaddr.isValid(host) && isBlockedIp(host)) {
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
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { safe: false, reason: "invalid_url" }; }
  if (!isSafeWebhookUrl(url, allowLocal)) return { safe: false, reason: "preflight_rejected" };

  const protocol = parsed.protocol as "http:" | "https:";
  const port = parsed.port ? Number(parsed.port) : (protocol === "https:" ? 443 : 80);
  // Same normalisation as the preflight path, so the fast path and the
  // DNS path interpret the host identically.
  const host = normaliseHost(parsed.hostname);
  if (!host) return { safe: false, reason: "invalid_host" };

  // If host is a literal IP, no DNS step -- just re-validate against blocklist.
  // This is the path where a literal metadata address would be accepted
  // without any DNS check, so it must apply the full blocklist.
  if (ipaddr.isValid(host)) {
    if (!allowLocal && isBlockedIp(host)) {
      return { safe: false, reason: "ip_blocked" };
    }
    const family = (ipaddr.parse(host).kind() === "ipv4" ? 4 : 6) as 4 | 6;
    return { safe: true, target: {hostname: host, ip: host, family, port, protocol } };
  }

  // Resolve all N/AAAA records. Reject if any single address is blocked --
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
      if (isBlockedIp(a.address)) {
        return { safe: false, reason: `blocked_ip:${a.address}` };
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
      lookup: (
        _hostname: string,
        opts: unknown,
        cb: (err: Error | null, address: any, family?: number) => void,
      ): void => {
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
import { describe, it, expect } from "vitest";
import {
  deriveClientIp,
  isLoopback,
  resolveTrustedProxyHops,
  DEFAULT_TRUSTED_PROXY_HOPS,
  type HeaderReader,
} from "../src/client_ip.ts";

function createMockReq(headers: Record<string, string>): HeaderReader {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return {
    header: (name: string) => normalized[name.toLowerCase()],
  };
}

describe("Client IP Trust Model & Derivation (Issue #190)", () => {
  it("asserts derived key for request carrying forged X-Real-IP and no other signal is 'anon' (Acceptance Criteria 1)", () => {
    // Attack scenario: Attacker sends forged X-Real-IP directly with no proxy/peer information
    const req = createMockReq({
      "x-real-ip": "198.51.100.77",
    });

    const derived = deriveClientIp(req);

    // MUST NOT return the attacker's forged IP; must safely degrade to the shared 'anon' bucket
    expect(derived).toBe("anon");
  });

  it("recognises all IPv6 and IPv4 loopback forms as loopback (Acceptance Criteria 2)", () => {
    // IPv4 & localhost
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("127.255.255.255")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);

    // IPv6 compressed
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);

    // IPv4-mapped IPv6 loopbacks
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("[::ffff:127.0.0.1]")).toBe(true);
    expect(isLoopback("::ffff:127.10.20.30")).toBe(true);
    expect(isLoopback("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("0000:0000:0000:0000:0000:ffff:127.0.0.1")).toBe(true);

    // Fully uncompressed IPv6 loopback
    expect(isLoopback("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopback("[0:0:0:0:0:0:0:1]")).toBe(true);
    expect(isLoopback("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isLoopback("[0000:0000:0000:0000:0000:0000:0000:0001]")).toBe(true);

    // Non-loopback addresses must return false
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("203.0.113.195")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
    expect(isLoopback("")).toBe(false);
    expect(isLoopback(null)).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it("prioritizes unforgeable routable socket peer remoteAddr when present", () => {
    const req = createMockReq({
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      "x-real-ip": "9.9.9.9",
    });

    const connInfo = {
      remoteAddr: { hostname: "203.0.113.50" },
    };

    const derived = deriveClientIp(req, connInfo);
    // Directly connects from routable peer: ignore all spoofable headers
    expect(derived).toBe("203.0.113.50");
  });

  it("trusts X-Real-IP when connection arrives from a verified loopback proxy peer", () => {
    const req = createMockReq({
      "x-real-ip": "198.51.100.88",
    });

    // Immediate peer is loopback (e.g. local reverse-proxy/nginx)
    const connInfo = {
      remoteAddr: { hostname: "127.0.0.1" },
    };

    const derived = deriveClientIp(req, connInfo);
    expect(derived).toBe("198.51.100.88");
  });

  it("correctly parses rightmost hop of X-Forwarded-For at configured trusted depth", () => {
    const req = createMockReq({
      "x-forwarded-for": "198.51.100.1, 203.0.113.20, 192.0.2.30",
    });

    // Default depth 1 (rightmost hop)
    expect(deriveClientIp(req, undefined, { trustedProxyHops: 1 })).toBe("192.0.2.30");

    // Depth 2 (second from right)
    expect(deriveClientIp(req, undefined, { trustedProxyHops: 2 })).toBe("203.0.113.20");

    // Depth exceeds chain length: do not trust arbitrary leftmost hops
    expect(deriveClientIp(req, undefined, { trustedProxyHops: 4 })).toBe("anon");
  });

  it("strictly validates TRUSTED_PROXY_HOPS and fails closed on invalid values", () => {
    expect(resolveTrustedProxyHops("1")).toBe(1);
    expect(resolveTrustedProxyHops("2")).toBe(2);
    expect(resolveTrustedProxyHops(undefined)).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(resolveTrustedProxyHops("")).toBe(DEFAULT_TRUSTED_PROXY_HOPS);

    expect(() => resolveTrustedProxyHops("0")).toThrowError(/Invalid TRUSTED_PROXY_HOPS/);
    expect(() => resolveTrustedProxyHops("-1")).toThrowError(/Invalid TRUSTED_PROXY_HOPS/);
    expect(() => resolveTrustedProxyHops("abc")).toThrowError(/Invalid TRUSTED_PROXY_HOPS/);
    expect(() => resolveTrustedProxyHops("1.5")).toThrowError(/Invalid TRUSTED_PROXY_HOPS/);
  });
});

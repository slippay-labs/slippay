import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import {
  isSafeWebhookUrl,
  isBlockedIp,
  validateWebhookUrl,
  IPV4_BLOCKED_RANGES,
  IPV6_BLOCKED_RANGES,
} from "../src/ssrf.js";

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

// allowLocal === false is the production default (full guard on every network);
// allowLocal === true is the dev-only escape hatch (lightweight path).
describe("isSafeWebhookUrl", () => {
  it("accepts https URLs to public hosts", () => {
    expect(isSafeWebhookUrl("https://example.com/wh", false)).toBe(true);
  });

  it("rejects http when allowLocal is false", () => {
    expect(isSafeWebhookUrl("http://example.com/wh", false)).toBe(false);
  });

  it("allows http when allowLocal is true (dev convenience)", () => {
    expect(isSafeWebhookUrl("http://example.com/wh", true)).toBe(true);
  });

  it("rejects RFC1918 destinations when allowLocal is false", () => {
    for (const url of ["http://10.0.0.1/wh", "https://192.168.1.1/wh", "https://172.16.0.5/wh"]) {
      expect(isSafeWebhookUrl(url, false)).toBe(false);
    }
  });

  it("rejects localhost when allowLocal is false", () => {
    expect(isSafeWebhookUrl("https://localhost/wh", false)).toBe(false);
    expect(isSafeWebhookUrl("https://127.0.0.1/wh", false)).toBe(false);
    expect(isSafeWebhookUrl("https://[::1]/wh", false)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isSafeWebhookUrl("not a url", false)).toBe(false);
    expect(isSafeWebhookUrl("ftp://example.com", false)).toBe(false);
  });

  it("rejects URLs with embedded credentials when allowLocal is false", () => {
    expect(isSafeWebhookUrl("https://user:pass@example.com/wh", false)).toBe(false);
  });

  it("rejects non-standard ports when allowLocal is false", () => {
    expect(isSafeWebhookUrl("https://example.com:8080/wh", false)).toBe(false);
    expect(isSafeWebhookUrl("https://example.com:443/wh", false)).toBe(true);
  });
});

describe("isBlockedIp", () => {
  it("blocks cloud metadata IP (169.254.169.254)", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks full 169.254/16 link-local range", () => {
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("169.254.255.255")).toBe(true);
  });

  it("blocks CGNAT 100.64/10", () => {
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.127.255.255")).toBe(true);
    expect(isBlockedIp("100.128.0.0")).toBe(false); // outside the /10
  });

  it("blocks full loopback 127/8 (not just .0.1)", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.5.6.7")).toBe(true);
  });

  it("blocks IPv6 ULA (fc00::/7) and link-local (fe80::/10)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 form of internal IPs", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  describe("transition & translation ranges (fixes #247)", () => {
    it("blocks 6to4 (2002::/16) addresses", () => {
      // Embedded RFC1918 or metadata IP
      expect(isBlockedIp("2002:a9fe:a9fe::1")).toBe(true);
      expect(isBlockedIp("2002:c0a8:0101::1")).toBe(true);
      expect(isBlockedIp("2002::1")).toBe(true);
    });

    it("blocks Teredo (2001::/32) addresses", () => {
      expect(isBlockedIp("2001::1")).toBe(true);
      expect(isBlockedIp("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
    });

    it("blocks NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) addresses", () => {
      // 64:ff9b::a9fe:a9fe embeds 169.254.169.254
      expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true);
      expect(isBlockedIp("64:ff9b::7f00:0001")).toBe(true); // embeds 127.0.0.1
      expect(isBlockedIp("64:ff9b::1")).toBe(true);
      expect(isBlockedIp("64:ff9b:1::1")).toBe(true);
    });

    it("enumerates every blocked IPv4 range with a sample address", () => {
      const samples = [
        "0.1.2.3",          // 0.0.0.0/8
        "10.254.1.1",       // 10.0.0.0/8
        "100.64.10.1",      // 100.64.0.0/10
        "127.0.0.5",        // 127.0.0.0/8
        "169.254.169.254",  // 169.254.0.0/16
        "172.16.50.1",      // 172.16.0.0/12
        "192.0.0.8",        // 192.0.0.0/24
        "192.0.2.1",        // 192.0.2.0/24
        "192.168.1.100",    // 192.168.0.0/16
        "198.18.0.25",      // 198.18.0.0/15
        "198.51.100.4",     // 198.51.100.0/24
        "203.0.113.8",      // 203.0.113.0/24
        "224.1.2.3",        // 224.0.0.0/4
        "240.5.6.7",        // 240.0.0.0/4
      ];
      expect(samples.length).toBe(IPV4_BLOCKED_RANGES.length);
      for (const ip of samples) {
        expect(isBlockedIp(ip)).toBe(true);
      }
    });

    it("enumerates every blocked IPv6 range with a sample address", () => {
      const samples = [
        "::",                                         // unspecified
        "::1",                                        // loopback
        "fc00::1",                                    // ULA
        "fe80::1",                                    // link-local
        "ff02::1",                                    // multicast
        "100::1",                                     // discard-only
        "2001:db8::1",                                // documentation
        "2001::1",                                    // Teredo
        "2001:20::1",                                 // ORCHIDv2
        "2001:10::1",                                 // Deprecated ORCHID
        "64:ff9b::1",                                 // NAT64 well-known
        "64:ff9b:1::1",                               // NAT64 local-use
        "2002::1",                                    // 6to4
      ];
      expect(samples.length).toBe(IPV6_BLOCKED_RANGES.length);
      for (const ip of samples) {
        expect(isBlockedIp(ip)).toBe(true);
      }
    });
  });

  it("blocks multicast and reserved", () => {
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("240.0.0.1")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS v6
  });

  it("rejects invalid strings (fail-closed)", () => {
    expect(isBlockedIp("not an ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("validateWebhookUrl · DNS rebinding defense", () => {
  beforeEach(() => mockLookup.mockReset());

  it("rejects URL whose DNS resolves to 169.254.169.254 (allowLocal=false)", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const r = await validateWebhookUrl("https://rebind.attacker.example/wh", false);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/^blocked_ip:/);
  });

  it("rejects URL whose DNS returns any private IP among many (allowLocal=false)", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const r = await validateWebhookUrl("https://multihome.example/wh", false);
    expect(r.safe).toBe(false);
  });

  it("accepts and pins URL with public IP (allowLocal=false)", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const r = await validateWebhookUrl("https://example.com/wh", false);
    expect(r.safe).toBe(true);
    if (r.safe) {
      expect(r.target.ip).toBe("93.184.216.34");
      expect(r.target.hostname).toBe("example.com");
      expect(r.target.port).toBe(443);
    }
  });

  it("rejects literal IP in URL that's in blocklist (no DNS path)", async () => {
    const r = await validateWebhookUrl("https://169.254.169.254/latest/meta-data/", false);
    expect(r.safe).toBe(false);
  });

  it("rejects 64:ff9b::a9fe:a9fe with embedded-address reason (literal path)", async () => {
    const r = await validateWebhookUrl("https://[64:ff9b::a9fe:a9fe]/wh", false);
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reason).toBe("blocked_ip:embedded:169.254.169.254");
    }
  });

  it("rejects 64:ff9b::a9fe:a9fe with embedded-address reason (DNS path)", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]);
    const r = await validateWebhookUrl("https://nat64.attacker.example/wh", false);
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reason).toBe("blocked_ip:embedded:169.254.169.254");
    }
  });

  it("rejects 2002:a9fe:a9fe::1 with embedded-address reason (6to4)", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "2002:a9fe:a9fe::1", family: 6 }]);
    const r = await validateWebhookUrl("https://6to4.attacker.example/wh", false);
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reason).toBe("blocked_ip:embedded:169.254.169.254");
    }
  });
});

// M3 regression guard: the entire SSRF defense used to be gated behind a
// `network === "mainnet"` check that was NEVER true on prod (STELLAR_NETWORK=
// PUBLIC coerced to "public", not "mainnet"). With the fail-closed allowLocal
// flag, a webhook_url resolving to a blocked literal IP must be rejected
// regardless of network — i.e. whenever allowLocal is false. Audit-003 L1.
describe("M3 · blocklist enforced on all networks (allowLocal=false)", () => {
  beforeEach(() => mockLookup.mockReset());

  it("rejects http://169.254.169.254/ (cloud IMDS) regardless of network", async () => {
    const r = await validateWebhookUrl("http://169.254.169.254/", false);
    expect(r.safe).toBe(false);
  });

  it("rejects http://127.0.0.1/ (loopback) regardless of network", async () => {
    const r = await validateWebhookUrl("http://127.0.0.1/", false);
    expect(r.safe).toBe(false);
  });

  it("rejects a hostname resolving to 127.0.0.1 (DNS path) regardless of network", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const r = await validateWebhookUrl("https://loopback.attacker.example/wh", false);
    expect(r.safe).toBe(false);
  });
});

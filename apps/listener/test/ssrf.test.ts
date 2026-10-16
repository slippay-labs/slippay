import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import {
  isSafeWebhookUrl,
  isBlockedIp,
  validateWebhookUrl,
  normaliseHost,
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

    describe("table-driven boundary tests: inside blocked, outside allowed (fixes #250)", () => {
      interface RangeBoundaryCase {
        name: string;
        range: string;
        inside: string;
        outside: string;
      }

      const ipv4Cases: RangeBoundaryCase[] = [
        { name: "this network", range: "0.0.0.0/8", inside: "0.0.0.1", outside: "1.0.0.1" },
        { name: "RFC1918 class A", range: "10.0.0.0/8", inside: "10.254.1.1", outside: "11.0.0.1" },
        { name: "CGNAT", range: "100.64.0.0/10", inside: "100.127.255.254", outside: "100.128.0.1" },
        { name: "loopback", range: "127.0.0.0/8", inside: "127.0.0.1", outside: "128.0.0.1" },
        { name: "link-local / IMDS", range: "169.254.0.0/16", inside: "169.254.169.254", outside: "169.255.0.1" },
        { name: "RFC1918 class B", range: "172.16.0.0/12", inside: "172.31.255.254", outside: "172.32.0.1" },
        { name: "IETF protocol assignments", range: "192.0.0.0/24", inside: "192.0.0.1", outside: "192.0.1.1" },
        { name: "TEST-NET-1", range: "192.0.2.0/24", inside: "192.0.2.1", outside: "192.0.3.1" },
        { name: "RFC1918 class C", range: "192.168.0.0/16", inside: "192.168.1.100", outside: "192.169.0.1" },
        { name: "benchmarking", range: "198.18.0.0/15", inside: "198.19.255.254", outside: "198.20.0.1" },
        { name: "TEST-NET-2", range: "198.51.100.0/24", inside: "198.51.100.1", outside: "198.51.101.1" },
        { name: "TEST-NET-3", range: "203.0.113.0/24", inside: "203.0.113.1", outside: "203.0.114.1" },
        { name: "multicast", range: "224.0.0.0/4", inside: "239.255.255.254", outside: "223.255.255.255" },
        { name: "reserved", range: "240.0.0.0/4", inside: "240.0.0.1", outside: "223.255.255.254" },
      ];

      it("verifies inside is blocked and outside is allowed for every IPv4 range", () => {
        expect(ipv4Cases.length).toBe(IPV4_BLOCKED_RANGES.length);
        for (const c of ipv4Cases) {
          expect(isBlockedIp(c.inside), `IPv4 inside ${c.range} (${c.inside}) must be blocked`).toBe(true);
          expect(isBlockedIp(c.outside), `IPv4 outside ${c.range} (${c.outside}) must be allowed`).toBe(false);
        }
      });

      const ipv6Cases: RangeBoundaryCase[] = [
        { name: "unspecified", range: "::/128", inside: "::", outside: "2606:4700:4700::1111" },
        { name: "loopback", range: "::1/128", inside: "::1", outside: "2606:4700:4700::1111" },
        { name: "ULA", range: "fc00::/7", inside: "fd12:3456::1", outside: "fe00::1" },
        { name: "link-local", range: "fe80::/10", inside: "fe80::1", outside: "fec0::1" },
        { name: "multicast", range: "ff00::/8", inside: "ff02::1", outside: "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
        { name: "discard-only", range: "100::/64", inside: "100::1", outside: "100:0:0:1::1" },
        { name: "documentation", range: "2001:db8::/32", inside: "2001:db8::1", outside: "2001:db9::1" },
        { name: "Teredo", range: "2001::/32", inside: "2001:0000:4136:e378:8000:63bf:3fff:fdd2", outside: "2001:1::1" },
        { name: "ORCHIDv2", range: "2001:20::/28", inside: "2001:20::1", outside: "2001:30::1" },
        { name: "Deprecated ORCHID", range: "2001:10::/28", inside: "2001:10::1", outside: "2001:0f::1" },
        { name: "NAT64 well-known", range: "64:ff9b::/96", inside: "64:ff9b::a9fe:a9fe", outside: "64:ff9c::1" },
        { name: "NAT64 local-use", range: "64:ff9b:1::/48", inside: "64:ff9b:1::1", outside: "64:ff9b:2::1" },
        { name: "6to4", range: "2002::/16", inside: "2002:a9fe:a9fe::1", outside: "2003::1" },
      ];

      it("verifies inside is blocked and outside is allowed for every IPv6 range", () => {
        expect(ipv6Cases.length).toBe(IPV6_BLOCKED_RANGES.length);
        for (const c of ipv6Cases) {
          expect(isBlockedIp(c.inside), `IPv6 inside ${c.range} (${c.inside}) must be blocked`).toBe(true);
          expect(isBlockedIp(c.outside), `IPv6 outside ${c.range} (${c.outside}) must be allowed`).toBe(false);
        }
      });
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

  it("rejects invalid and unparsable strings (fail-closed, fixes #250)", () => {
    const unparsable = [
      "not an ip",
      "",
      "   ",
      "999.999.999.999",
      "256.1.1.1",
      "1.2.3.4.5",
      "fe80:::1",
      ":::",
      "127.0.0.1:8080",
      "http://127.0.0.1",
      "127.0.0.1/wh",
      "1.2.3.4.",
      "1..2.3",
      "1.2.3.4.invalid",
    ];
    for (const str of unparsable) {
      expect(isBlockedIp(str), `String "${str}" must be blocked (fail-closed)`).toBe(true);
    }
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

describe("normaliseHost (fixes #248)", () => {
  it("normalises standard hostnames and IPs", () => {
    expect(normaliseHost("EXAMPLE.COM")).toEqual({ valid: true, host: "example.com", isIp: false });
    expect(normaliseHost("127.0.0.1")).toEqual({
      valid: true,
      host: "127.0.0.1",
      isIp: true,
      parsedIp: expect.anything(),
    });
  });

  it("strips balanced brackets from IPv6 and normalises representation", () => {
    expect(normaliseHost("[::1]")).toEqual({
      valid: true,
      host: "::1",
      isIp: true,
      parsedIp: expect.anything(),
    });
    expect(normaliseHost("[0:0:0:0:0:0:0:1]")).toEqual({
      valid: true,
      host: "::1",
      isIp: true,
      parsedIp: expect.anything(),
    });
  });

  it("rejects unbalanced or malformed brackets", () => {
    expect(normaliseHost("[::1")).toEqual({ valid: false, reason: "unbalanced_brackets" });
    expect(normaliseHost("::1]")).toEqual({ valid: false, reason: "unbalanced_brackets" });
    expect(normaliseHost("[[::1]]")).toEqual({ valid: false, reason: "malformed_brackets" });
  });

  it("rejects zone identifiers (scoped addresses)", () => {
    expect(normaliseHost("fe80::1%eth0")).toEqual({ valid: false, reason: "zone_identifier_rejected" });
    expect(normaliseHost("[fe80::1%eth0]")).toEqual({ valid: false, reason: "zone_identifier_rejected" });
  });
});

describe("literal-IP path test vectors (fixes #248)", () => {
  const vectors = [
    { target: "https://[::1]/wh", expectedReason: "ip_blocked", desc: "loopback [::1]" },
    {
      target: "https://[::ffff:127.0.0.1]/wh",
      expectedReason: "blocked_ip:embedded:127.0.0.1",
      desc: "IPv4-mapped ::ffff:127.0.0.1",
    },
    {
      target: "https://[0:0:0:0:0:0:0:1]/wh",
      expectedReason: "ip_blocked",
      desc: "uncompressed loopback 0:0:0:0:0:0:0:1",
    },
    {
      target: "https://[fe80::1%eth0]/wh",
      expectedReason: "zone_identifier_rejected",
      desc: "link-local with zone identifier fe80::1%eth0",
    },
    {
      target: "https://169.254.169.254/wh",
      expectedReason: "ip_blocked",
      desc: "cloud metadata IPv4 literal 169.254.169.254",
    },
    {
      target: "https://[64:ff9b::a9fe:a9fe]/wh",
      expectedReason: "blocked_ip:embedded:169.254.169.254",
      desc: "NAT64 prefix embedding cloud metadata 64:ff9b::a9fe:a9fe",
    },
  ];

  for (const v of vectors) {
    it(`rejects ${v.desc} with reason ${v.expectedReason}`, async () => {
      const r = await validateWebhookUrl(v.target, false);
      expect(r.safe).toBe(false);
      if (!r.safe) {
        expect(r.reason).toBe(v.expectedReason);
      }
    });
  }
});

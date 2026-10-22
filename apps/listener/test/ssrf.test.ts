import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { isSafeWebhookUrl, isBlockedIp, validateWebhookUrl } from "../src/ssrf.js";

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

// ----------------------------------------------------------------------------
// Table-driven coverage of the blocklist data.
// Every row of IPV4_BLOCKED_RANGES and IPV6_BLOCKED_RANGES must have
// an inside and an outside assertion. A prefix typo is the only thing
// this catches.
// ----------------------------------------------------------------------------

interface RangeCase {
  name: string;
  inside: string;
  outside: string;
}

// One row per entry in the IPv4 blocklist.
// "outside" is the adjacent address just past the prefix boundary.
const IPV4$CASES: RangeCase[] = [
  { name: "0.0.0.0/8", inside: "0.0.0.0", outside: "1.0.0.0" },
  { name: "10.0.0.0/8", inside: "10.0.0.1", outside: "11.0.0.0" },
  { name: "100.64.0.0/10", inside: "100.64.0.1", outside: "100.128.0.0" },
  { name: "127.0.0.0/8", inside: "127.0.0.1", outside: "128.0.0.0" },
  { name: "169.254.0.0/16", inside: "169.254.169.254", outside: "169.255.0.0" },
  { name: "172.16.0.0/12", inside: "172.16.0.1", outside: "172.32.0.0" },
  { name: "192.168.0.0/16", inside: "192.168.1.1", outside: "192.169.0.0" },
  { name: "198.18.0.0/15", inside: "198.18.0.1", outside: "198.20.0.0" },
  { name: "198.51.100.0/24", inside: "198.51.100.1", outside: "198.51.101.0" },
  { name: "224.0.0.0/4", inside: "224.0.0.1", outside: "240.0.0.0" },
  { name: "240.0.0.0/4", inside: "240.0.0.1", outside: "224.0.0.0" },
  // Transition prefixes (missing per issue 89).
  { name: "192.0.0.0/24", inside: "192.0.0.1", outside: "192.0.1.0" },
  { name: "192.0.2.0/24", inside: "192.0.2.1", outside: "192.0.3.0" },
  { name: "198.18.0.0/15", inside: "198.19.255.254", outside: "198.20.0.0" },
];

// One row per entry in the IPv6 blocklist.
const IPV6$CASES: RangeCase[] = [
  { name: "::/128", inside: "::", outside: "::1" },
  { name: "::1/128", inside: "::1", outside: "::2" },
  { name: "fc00::/7", inside: "fc00::1", outside: "fe00::1" },
  { name: "fe80::/10", inside: "fe80::1", outside: "fec0::1" },
  { name: "ff00::/8", inside: "ff02::1", outside: "fe00::1" },
  { name: "2001:db8::/32", inside: "2001:db8::1", outside: "2001:db9::1" },
  { name: "2002::/48", inside: "2002::1", outside: "2003:(:1" },
];

describe("isBlockedIp · IPv4 blocklist table", () => {
  it.each(IPV4$CASES)("blocks $inside and allows $outside ($name)", ({ side, outside }) => {
    expect(isBlockedIp(inside)).toBe(true);
    expect(isBlockedIp(outside)).toBe(false);
  });
});

describe("isBlockedIp · IPv6 blocklist table", () => {
  it.each(IPV6$CASES)("blocks $inside and allows $outside ($name)", ({ inside, outside }) => {
    expect(isBlockedIp(inside)).toBe(true);
    expect(isBlockedIp(outside)).toBe(false);
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
    mockLookup.mockResolvedOnce([{ address: "169.254.169.254", family: 4 }]);
    const r = await validateWebhookUrl("https://rebind.attacker.example/wh", false);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/^blocked_ip:/);
  });

  it("rejects URL whose DNS returns any private IP among many (allowLocal=false)", async () => {
    mockLookup.mockResolvedOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const r = await validateWebhookUrl("https://multihome.example/wh", false);
    expect(r.safe).toBe(false);
  });

  it("accepts and pins URL with public IP (allowLocal=false)", async () => {
    mockLookup.mockResolvedOnce([{ address: "93.184.216.34", family: 4 }]);
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
    mockLookup.mockResolvedOnce([{ address: "127.0.0.1", family: 4 }]);
    const r = await validateWebhookUrl("https://loopback.attacker.example/wh", false);
    expect(r.safe).toBe(false);
  });
});

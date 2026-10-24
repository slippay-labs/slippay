import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { nextBackoff, deliverOnce, validateWebhookUrl, pinnedDispatcher } from "../src/webhook.js";
import {
  signWebhook,
  verifyWebhook,
  createReplayCache,
  DEFAULT_TOLERANCE_S,
} from "../src/crypto.js";

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe("nextBackoff", () => {
  it("returns escalating delays per attempt", () => {
    expect(nextBackoff(0)).toBe(60);
    expect(nextBackoff(1)).toBe(500);
    expect(nextBackoff(2)).toBe(1800);
    expect(nextBackoff(3)).toBe(7200);
    expect(nextBackoff(4)).toBe(43200);
    expect(nextBackoff(5)).toBe(86400);
    expect(nextBackoff(6)).toBe(null);
  });
});

describe("deliverOnce", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    // example.com resolves to a public IP; allowLocal:true skips the blocklist
    // anyway, but validateWebhookUrl still pins the resolved address.
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns sent on 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const r = await deliverOnce({
      url: "https://example.com/wh",
      secret: "s",
      deliveryId: "d-1",
      payload: { type: "order.paid", data: { id: "o-1" } },
      allowLocal: true,
    });
    expect(r.status).toBe("sent");
    expect(r.code).toBe(200);
  });

  it("returns failed on 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 503 })));
    const r = await deliverOnce({ url: "https://example.com/wh", secret: "s", deliveryId: "d-2", payload: {}, allowLocal: true });
    expect(r.status).toBe("failed");
  });

  it("returns failed on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns")));
    const r = await deliverOnce({ url: "https://example.com/wh", secret: "s", deliveryId: "d-3", payload: {}, allowLocal: true });
    expect(r.status).toBe("failed");
  });

  // M3 regression guard at the deliverOnce layer: with allowLocal=false (the
  // production default), a webhook_url resolving to a blocked literal IP is
  // rejected before any fetch is attempted, regardless of network. Audit-003 L1.
  it("rejects a blocked literal IP without fetching (allowLocal=false)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const url of ["http://169.254.169.254/", "http://127.0.0.1/"]) {
      const r = await deliverOnce({ url, secret: "s", deliveryId: "d-blocked", payload: {}, allowLocal: false });
      expect(r.status).toBe("failed");
      expect(r.body).toMatch(/^unsafe_url:/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A rejected URL must not produce any outbound connection attempt.
  // The fetch spy asserts the delivery layer never invokes fetch at all.
  it("a rejected URL must not produce any outbound connection", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const r = await deliverOnce({
      url: "http://internal.example.com/wh",
      secret: "s",
      deliveryId: "d-reject",
      payload: {},
      allowLocal: false,
    });
    expect(r.status).toBe("failed");
    expect(r.body).toMatch(/^unsafe_url:/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const pinnedTarget = {
  hostname: "example.com",
  ip: "93.184.216.34",
  family: 4 as const,
  port: 443,
  protocol: "https:" as const,
};

type LookupFn = (
  hostname: string,
  opts: { all?: boolean },
  cb: (...args: unknown[]) => void,
) => void;

function getLookupFn(dispatcher: unknown): LookupFn {
  const opts = (dispatcher as { options: { connect: { lookup: LookupFn } } }).options;
  return opts.connect.lookup;
}

describe("pinnedDispatcher lookup", () => {
  it("returns an array of { address, family } when opts.all is true", () => {
    const dispatcher = pinnedDispatcher(pinnedTarget);
    const lookupFn = getLookupFn(dispatcher);
    expect(typeof lookupFn).toBe("function");
    const cb = vi.fn();
    lookupFn("example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: pinnedTarget.ip, family: pinnedTarget.family }]);
  });

  it("returns (null, ip, family) when opts.all is not set", () => {
    const dispatcher = pinnedDispatcher(pinnedTarget);
    const lookupFn = getLookupFn(dispatcher);
    expect(typeof lookupFn).toBe("function");
    const cb = vi.fn();
    lookupFn("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, pinnedTarget.ip, pinnedTarget.family);
  });
});

describe("DNS rebinding pinning", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
  });

  // The security property: validation resolves and pins an address, and the
  // connection must use that pinned address even if DNS changes after validation.
  it("connects to the pinned address even when DNS rebinds after validation", async () => {
    // Local server that reports the peer address it was contacted on.
    const server = createServer((req, res) => {
      const peer = req.socket.remoteAddress as string;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(peer);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const port = address.port;
    try {
      // Validation time resolves to the local server.
      mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const validated = await validateWebhookUrl(`http://pin.test.local:${port}/wh`, true);
      expect(validated.safe).toBe(true);
      if (!validated.safe) return;
      expect(validated.target.ip).toBe("127.0.0.1");

      // DNS rebinds after validation to a different address.
      mockLookup.mockResolvedValue([{ address: "198.51.100.7", family: 4 }]);

      // The pinned dispatcher must still connect to the original address.
      const dispatcher = pinnedDispatcher(validated.target);
      const res = await fetch(`http://pin.test.local:${port}/wh`, {
        dispatcher,
      } as RequestInit);
      expect(res.status).toBe(200);
      const peer = await res.text();
      expect(peer).toBe("127.0.0.1");
      // The second resolution changed the DNS answer, but the connection
      // must not have gone to the rebind target.
      expect(peer).not.toBe("198.51.100.7");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("webhook signature replay protection", () => {
  const secret = "wh_secret_test";
  const body = JSON.stringify({ type: "order.paid", data: { id: "o-1" } });

  it("exposes a documented default tolerance", () => {
    expect(typeof DEFAULT_TOLERANCE_S).toBe("number");
    expect(DEFAULT_TOLERANCE_S).toBeGreaterThan(0);
    expect(DEFAULT_TOLERANCE_S).toBeLessThanOrEqual(300);
  });

  it("rejects the same signed request submitted twice within the tolerance", () => {
    const cache = createReplayCache();
    const now = Math.floor(Date.now() / 1000);
    const { header } = signWebhook(secret, body, now);
    expect(verifyWebhook(secret, body, header, { now, cache })).toBe(true);
    expect(verifyWebhook(secret, body, header, { now, cache })).toBe(false);
  });

  it("rejects a body replayed under a different delivery id", () => {
    const cache = createReplayCache();
    const now = Math.floor(Date.now() / 1000);
    const { header } = signWebhook(secret, body, now);
    expect(verifyWebhook(secret, body, header, { now, cache, deliveryId: "d-1" })).toBe(true);
    expect(verifyWebhook(secret, body, header, { now, cache, deliveryId: "d-2" })).toBe(false);
  });

  it("accepts a fresh signature after the cache entry expires", () => {
    const cache = createReplayCache();
    const now = Math.floor(Date.now() / 1000);
    const { header } = signWebhook(secret, body, now);
    expect(verifyWebhook(secret, body, header, { now, cache })).toBe(true);
    expect(verifyWebhook(secret, body, header, { now, cache })).toBe(false);
    expect(
      verifyWebhook(secret, body, header, { now: now + DEFAULT_TOLERANCE_S + 1, cache }),
    ).toBe(false);
  });

  it("rejects a signature outside the configured tolerance", () => {
    const cache = createReplayCache();
    const now = Math.floor(Date.now() / 1000);
    const { header } = signWebhook(secret, body, now);
    expect(
      verifyWebhook(secret, body, header, { now: now + 10, cache, toleranceS: 5 }),
    ).toBe(false);
  });
});
import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
 // through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { nextBackoff, deliverOnce, processBatch } from "../src/webhook.js";

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe("nextBackoff", () => {
  it("returns escalating delays per attempt", () => {
    expect(nextBackoff(0)).toBe(60);
    expect(nextBackoff(1)).toBe(300);
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
    // example.com resolves to a public IP; allowLocal:tru skips the blocklist
    // anyway, but validateWebhookUrl still pins the resolved address.
    mockLookup.mockResolved([{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns sent on 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolved(new Response("ok", { status: 200 })));
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
    vi.stubGlobal("fetch", vi.fn().mockResolved(new Response("err", { status: 503 })));
    const r = await deliverOnce({ url: "https://example.com/wh", secret: "s", deliveryId: "d-2", payload: {}, allowLocal: true });
    expect(r.status).toBe("failed");
  });

  it("returns failed on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejected(new Error("dns")));
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
});

describe("processBatch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    mockLookup.mockResolved([{ address: "93.184.216.34", family: 4 }]);
  });

  it("never exceeds the configured in-flight concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const handler = vi.fn().mockImplement(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { status: "sent" as const, code: 200 };
    });

    const items = Array.from({ length: 20 }, (_, i) => (i));
    const results = await processBatch(items, handler, { concurrency: 4, perHostConcurrency: 4 });

    expect(results).toHaveLength(20);
    expect(handler).toHaveBeenCalled(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("does not let a permanently slow receiver delay the rest of the batch", async () => {
    const slowHost = "slow.example.com";
    const fastHost = "fast.example.com";
    const startedAt = Date.now();
    const completedAt = new Map<string, number>();

    const handler = vi.fn().mockImplement(async (item: { id: string; host: string }) => {
      if (item.host === slowHost) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      completedAt.set(item.id, Date.now() - startedAt);
      return { status: "sent" as const, code: 200 };
    });

    const items = [
      { id: "slow-1", host: slowHost },
      { id: "slow-2", host: slowHost },
      { id: "fast-1", host: fastHost },
      { id: "fast-2", host: fastHost },
      { id: "fast-3", host: fastHost },
    ];

    const results = await processBatch(items, handler, {
      concurrency: 4,
      perHostConcurrency: 1,
      hostOf: (item) => item.host,
    });

    expect(results).toHaveLength(5);
    // The fast deliveries must finish well before the slow ones have expired.
    for (const id of ["fast-1", "fast-2", "fast-3"]) {
      expect(completedAt.get(id)).toBeLessThan(500);
    }
  });

  it("records per-attempt duration for each delivery", async () => {
    const handler = vi.fn().mockImplement(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "sent" as const, code: 200 };
    });

    const items = [{ id: "a", host: "fast.example.com" }, { id: "b", host: "fast.example.com" }];
    const results = await processBatch(items, handler, {
      concurrency: 2,
      perHostConcurrency: 2,
      hostOf: (item) => item.host,
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(10);
    }
  });
});

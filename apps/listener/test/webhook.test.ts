import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { nextBackoff, deliverOnce, deliverBatchWithConcurrency, processWebhookBatch, startWebhookWorker } from "../src/webhook.js";

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
});

describe("deliverBatchWithConcurrency · bounded pool and per-host isolation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  function makeMockDeliveryDb() {
    const updates: Array<{ id: string; payload: any }> = [];
    return {
      updates,
      from: (_tableName: string) => ({
        update: (payload: any) => ({
          eq: (_col: string, id: string) => {
            updates.push({ id, payload });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
  }

  it("ensures a slow receiver does not block other merchant deliveries in the batch", async () => {
    const completionTimes: Record<string, number> = {};
    const startTime = Date.now();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("slow-receiver.com")) {
          // Slow receiver delays 150ms
          return new Promise((resolve) =>
            setTimeout(() => {
              completionTimes["slow"] = Date.now() - startTime;
              resolve(new Response("ok", { status: 200 }));
            }, 150),
          );
        } else {
          // Fast receivers respond fast (10ms)
          return new Promise((resolve) =>
            setTimeout(() => {
              const name = url.includes("fast-a") ? "fast-a" : "fast-b";
              completionTimes[name] = Date.now() - startTime;
              resolve(new Response("ok", { status: 200 }));
            }, 10),
          );
        }
      }),
    );

    const rows = [
      {
        id: "d-slow",
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: "https://slow-receiver.com/wh", webhook_secret: "sec" } },
      },
      {
        id: "d-fast-a",
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: "https://fast-a.com/wh", webhook_secret: "sec" } },
      },
      {
        id: "d-fast-b",
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: "https://fast-b.com/wh", webhook_secret: "sec" } },
      },
    ];

    const mockDb = makeMockDeliveryDb();
    await deliverBatchWithConcurrency(rows, true, mockDb as any, {
      concurrency: 3,
      perHostConcurrency: 1,
    });

    expect(completionTimes["fast-a"]).toBeDefined();
    expect(completionTimes["fast-b"]).toBeDefined();
    expect(completionTimes["slow"]).toBeDefined();

    // The fast deliveries must finish way earlier than the slow one
    expect(completionTimes["fast-a"]).toBeLessThan(completionTimes["slow"]);
    expect(completionTimes["fast-b"]).toBeLessThan(completionTimes["slow"]);
  });

  it("asserts concurrent in-flight deliveries never exceed configured concurrency or per-host limits", async () => {
    let inFlightTotal = 0;
    let maxObservedTotal = 0;
    const inFlightPerHost: Record<string, number> = {};
    const maxObservedPerHost: Record<string, number> = {};

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const host = new URL(url).hostname;
        inFlightTotal++;
        if (inFlightTotal > maxObservedTotal) maxObservedTotal = inFlightTotal;

        inFlightPerHost[host] = (inFlightPerHost[host] ?? 0) + 1;
        if ((maxObservedPerHost[host] ?? 0) < inFlightPerHost[host]) {
          maxObservedPerHost[host] = inFlightPerHost[host];
        }

        return new Promise((resolve) =>
          setTimeout(() => {
            inFlightTotal--;
            inFlightPerHost[host]--;
            resolve(new Response("ok", { status: 200 }));
          }, 30),
        );
      }),
    );

    // 8 items across two hosts: 4 on host-1, 4 on host-2
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `h1-${i}`,
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: `https://host1.com/wh`, webhook_secret: "sec" } },
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `h2-${i}`,
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: `https://host2.com/wh`, webhook_secret: "sec" } },
      })),
    ];

    const mockDb = makeMockDeliveryDb();
    await deliverBatchWithConcurrency(rows, true, mockDb as any, {
      concurrency: 3,
      perHostConcurrency: 2,
    });

    // Global cap respected
    expect(maxObservedTotal).toBeLessThanOrEqual(3);
    // Per-host cap respected
    expect(maxObservedPerHost["host1.com"]).toBeLessThanOrEqual(2);
    expect(maxObservedPerHost["host2.com"]).toBeLessThanOrEqual(2);
  });

  it("records per-attempt duration_ms on each delivery update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

    const rows = [
      {
        id: "d-dur",
        payload: {},
        attempt_n: 0,
        orders: { merchants: { webhook_url: "https://example.com/wh", webhook_secret: "sec" } },
      },
    ];

    const mockDb = makeMockDeliveryDb();
    await deliverBatchWithConcurrency(rows, true, mockDb as any, { concurrency: 1 });

    expect(mockDb.updates.length).toBe(1);
    const update = mockDb.updates[0];
    expect(update.id).toBe("d-dur");
    expect(typeof update.payload.duration_ms).toBe("number");
    expect(update.payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(update.payload.status).toBe("sent");
  });

  it("starts and stops startWebhookWorker cleanly", async () => {
    const mockDb = {
      from: () => ({
        select: () => ({
          in: () => ({
            lte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    };
    const stop = startWebhookWorker(mockDb as any, true, { pollIntervalMs: 10_000 });
    expect(typeof stop).toBe("function");
    stop();
  });
});

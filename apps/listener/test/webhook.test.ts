import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { nextBackoff, deliverOnce, processWebhookBatch, startWebhookWorker } from "../src/webhook.js";

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

describe("webhook worker · single-owner lease claim and concurrency", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  function createMockDb(initialRows: any[]) {
    const table = initialRows.map((r) => ({ ...r }));

    return {
      table,
      from: (tableName: string) => {
        expect(tableName).toBe("webhook_deliveries");

        return {
          select: (_cols: string) => {
            const chain: any = {
              in: (_col: string, _statuses: string[]) => chain,
              order: () => chain,
              limit: () =>
                Promise.resolve({
                  data: table
                    .filter((r) => ["queued", "failed", "delivering"].includes(r.status))
                    .map((r) => JSON.parse(JSON.stringify(r))),
                  error: null,
                }),
            };
            return chain;
          },
          update: (payload: any) => {
            let targetId: string | null = null;
            let statusInFilter: string[] | null = null;
            let statusEqFilter: string | null = null;
            let lteClaimExpires: string | null = null;

            const chain: any = {
              eq: (col: string, val: string) => {
                if (col === "id") targetId = val;
                if (col === "status") statusEqFilter = val;
                return chain;
              },
              in: (col: string, vals: string[]) => {
                if (col === "status") statusInFilter = vals;
                return chain;
              },
              lte: (col: string, val: string) => {
                if (col === "claim_expires_at") lteClaimExpires = val;
                return chain;
              },
              select: () => chain,
              maybeSingle: () => {
                const row = table.find((r) => r.id === targetId);
                if (!row) return Promise.resolve({ data: null, error: null });

                // Evaluate CAS condition
                if (statusInFilter && !statusInFilter.includes(row.status)) {
                  return Promise.resolve({ data: null, error: null });
                }
                if (statusEqFilter && row.status !== statusEqFilter) {
                  return Promise.resolve({ data: null, error: null });
                }
                if (lteClaimExpires && (!row.claim_expires_at || row.claim_expires_at > lteClaimExpires)) {
                  return Promise.resolve({ data: null, error: null });
                }

                // CAS match succeeded: apply payload
                Object.assign(row, payload);
                return Promise.resolve({ data: { id: row.id }, error: null });
              },
              then: (resolve: (v: any) => void) => {
                const row = table.find((r) => r.id === targetId);
                if (row) {
                  Object.assign(row, payload);
                }
                resolve({ error: null });
              },
            };
            return chain;
          },
        };
      },
    };
  }

  it("ensures two concurrent workers perform exactly one delivery for one row", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const fixtureRow = {
      id: "deliv-1",
      order_id: "order-1",
      payload: { type: "order.paid" },
      attempt_n: 0,
      status: "queued",
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      claimed_by: null,
      claim_expires_at: null,
      orders: {
        merchants: {
          webhook_url: "https://example.com/webhook",
          webhook_secret: "secret-123",
          network: "TESTNET",
        },
      },
    };

    const mockDb = createMockDb([fixtureRow]);

    // Run two worker batches concurrently against the same fixture
    const [count1, count2] = await Promise.all([
      processWebhookBatch(mockDb as any, true, { workerId: "worker-alpha" }),
      processWebhookBatch(mockDb as any, true, { workerId: "worker-beta" }),
    ]);

    // Acceptance criterion 1: One worker claimed & delivered, the other got raced and did 0
    expect(count1 + count2).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Acceptance criterion 2: Owner ID is recorded on the delivery
    const updatedRow = mockDb.table[0];
    expect(updatedRow.status).toBe("sent");
    expect(["worker-alpha", "worker-beta"]).toContain(updatedRow.claimed_by);
    expect(updatedRow.attempt_n).toBe(1);
  });

  it("reclaims a row claimed by a crashed worker after its deadline expires", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    // Row that was claimed by a crashed worker whose claim deadline expired 5 seconds ago
    const crashedRow = {
      id: "deliv-crashed",
      order_id: "order-2",
      payload: { type: "order.paid" },
      attempt_n: 1,
      status: "delivering",
      next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
      claimed_by: "crashed-worker-id",
      claim_expires_at: new Date(Date.now() - 5_000).toISOString(),
      orders: {
        merchants: {
          webhook_url: "https://example.com/webhook",
          webhook_secret: "secret-123",
          network: "TESTNET",
        },
      },
    };

    const mockDb = createMockDb([crashedRow]);

    const count = await processWebhookBatch(mockDb as any, true, {
      workerId: "active-reclaimer",
    });

    expect(count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const updatedRow = mockDb.table[0];
    expect(updatedRow.status).toBe("sent");
    expect(updatedRow.claimed_by).toBe("active-reclaimer");
    expect(updatedRow.attempt_n).toBe(2);
  });

  it("starts and stops startWebhookWorker cleanly", async () => {
    const mockDb = createMockDb([]);
    const stopWorker = startWebhookWorker(mockDb as any, true, {
      pollIntervalMs: 10_000,
    });
    expect(typeof stopWorker).toBe("function");
    stopWorker();
  });
});


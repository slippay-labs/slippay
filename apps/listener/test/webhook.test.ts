import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import {
  nextBackoff,
  deliverOnce,
  isPermanentFailure,
  isDeliveryExpired,
  processDeliveryRow,
  TERMINAL_NEXT_ATTEMPT_AT,
} from "../src/webhook.js";

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

describe("isPermanentFailure (Issue #244)", () => {
  it("treats 4xx (except 429) as permanent failures", () => {
    expect(isPermanentFailure(400)).toBe(true);
    expect(isPermanentFailure(401)).toBe(true);
    expect(isPermanentFailure(403)).toBe(true);
    expect(isPermanentFailure(404)).toBe(true);
    expect(isPermanentFailure(422)).toBe(true);
  });

  it("treats 429 Too Many Requests as retryable (not permanent)", () => {
    expect(isPermanentFailure(429)).toBe(false);
  });

  it("treats 5xx server errors and network errors as retryable", () => {
    expect(isPermanentFailure(500)).toBe(false);
    expect(isPermanentFailure(502)).toBe(false);
    expect(isPermanentFailure(503)).toBe(false);
    expect(isPermanentFailure(504)).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
  });
});

describe("isDeliveryExpired (Issue #244)", () => {
  const now = 1700000000000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  it("flags delivery as expired when order.expires_at is beyond max age", () => {
    const expiredOrder = { expires_at: new Date(now - ONE_DAY - 1000).toISOString() };
    expect(isDeliveryExpired(expiredOrder, now, ONE_DAY)).toBe(true);
  });

  it("does not flag delivery as expired when order is fresh", () => {
    const freshOrder = { expires_at: new Date(now + 3600000).toISOString() };
    expect(isDeliveryExpired(freshOrder, now, ONE_DAY)).toBe(false);
  });

  it("flags delivery as expired when order.created_at is beyond max age", () => {
    const oldOrder = { created_at: new Date(now - ONE_DAY - 5000).toISOString() };
    expect(isDeliveryExpired(oldOrder, now, ONE_DAY)).toBe(true);
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

describe("processDeliveryRow dead-lettering & retries (Issue #244)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  function createMockDb() {
    let lastUpdate: any = null;
    const db: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockImplementation((payload) => {
          lastUpdate = payload;
          return {
            eq: vi.fn().mockResolvedValue({ error: null }),
          };
        }),
      }),
      getLastUpdate: () => lastUpdate,
    };
    return db;
  }

  it("dead-letters immediately on 400 response without consuming full schedule", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad payload", { status: 400 })));
    const db = createMockDb();

    const row = {
      id: "del-400",
      attempt_n: 0,
      payload: { type: "order.paid" },
      orders: {
        merchants: {
          webhook_url: "https://example.com/wh",
          webhook_secret: "sec_123",
        },
      },
    };

    await processDeliveryRow(db, row, true);
    const update = db.getLastUpdate();

    expect(update.status).toBe("dead");
    expect(update.response_code).toBe(400);
    expect(update.response_body).toContain("permanent_client_error_400");
    expect(update.next_attempt_at).toBe(TERMINAL_NEXT_ATTEMPT_AT);
  });

  it("retries on 429 response using backoff schedule", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));
    const db = createMockDb();

    const row = {
      id: "del-429",
      attempt_n: 0,
      payload: {},
      orders: {
        merchants: {
          webhook_url: "https://example.com/wh",
          webhook_secret: "sec_123",
        },
      },
    };

    await processDeliveryRow(db, row, true);
    const update = db.getLastUpdate();

    expect(update.status).toBe("failed");
    expect(update.response_code).toBe(429);
    expect(update.next_attempt_at).not.toBe(TERMINAL_NEXT_ATTEMPT_AT);
  });

  it("dead-letters deliveries older than maximum age without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const db = createMockDb();

    const row = {
      id: "del-expired",
      attempt_n: 0,
      payload: {},
      orders: {
        expires_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        merchants: {
          webhook_url: "https://example.com/wh",
          webhook_secret: "sec_123",
        },
      },
    };

    await processDeliveryRow(db, row, true);
    const update = db.getLastUpdate();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(update.status).toBe("dead");
    expect(update.response_body).toBe("delivery_expired_max_age");
    expect(update.next_attempt_at).toBe(TERMINAL_NEXT_ATTEMPT_AT);
  });

  it("sets terminal next_attempt_at when retry schedule is exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server error", { status: 500 })));
    const db = createMockDb();

    const row = {
      id: "del-exhausted",
      attempt_n: 6, // 7th attempt will return null backoff
      payload: {},
      orders: {
        merchants: {
          webhook_url: "https://example.com/wh",
          webhook_secret: "sec_123",
        },
      },
    };

    await processDeliveryRow(db, row, true);
    const update = db.getLastUpdate();

    expect(update.status).toBe("dead");
    expect(update.response_body).toContain("attempts_exhausted");
    expect(update.next_attempt_at).toBe(TERMINAL_NEXT_ATTEMPT_AT);
  });
});

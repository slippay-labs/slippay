import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lm = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("../src/log.js", () => ({ log: lm.log }));

import { nextBackoff, deliverOnce, startWebhookWorker } from "../src/webhook.js";

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

// ─── startWebhookWorker · spin protection (slippay-labs/slippay#242) ────────
//
// Regression guards for the tight-loop bug: the worker used to sleep only when
// the select returned zero rows, so a delivery whose update silently failed
// (matched zero rows / status-write vs next_attempt_at mismatch) was re-selected
// and re-processed as fast as the DB round-trip allowed. The fixtures below
// keep the same row eligible forever and assert the loop stays bounded, the
// min interval is honoured, and a stuck delivery is dead-lettered.

interface MockRow {
  id: string;
  order_id: string;
  payload: unknown;
  attempt_n: number;
  status: string;
  orders: { merchants: { webhook_url?: string; webhook_secret?: string; network?: string } };
}

// Thenable Supabase-builder mock (same shape as manager.test.ts). The select
// chain returns `rows` — the stuck fixture never leaves the queue — and every
// update silently matches zero rows unless applyUpdates is set.
function makeDb(
  rows: MockRow[],
  opts: { failureMode?: "silent" | "deadletter-ok" | "all-ok"; provideRows?: () => MockRow[] } = {},
) {
  const counters = { select: 0, update: 0 };
  const updates: Record<string, unknown>[] = [];

  const db: any = {
    from: (table: string) => {
      expect(table).toBe("webhook_deliveries");
      const b: any = {
        _op: "select" as "select" | "update",
        _patch: null as Record<string, unknown> | null,
        select() { return b; },
        in() { return b; },
        lte() { return b; },
        order() { return b; },
        limit() { return b; },
        eq() { return b; },
        update(patch: Record<string, unknown>) {
          b._op = "update";
          b._patch = patch;
          counters.update++;
          updates.push(patch);
          return b;
        },
        then(resolve: (v: unknown) => void) {
          if (b._op === "select") {
            counters.select++;
            const source = opts.provideRows ? opts.provideRows() : rows;
            resolve({ data: source.map(r => ({ ...r })), error: null });
            return;
          }
          if (opts.failureMode === "all-ok") {
            resolve({ data: [{ id: rows[0]?.id }], error: null });
            return;
          }
          // The delivery's own status writes silently match zero rows — the
          // #85 flavour of the bug. The circuit breaker's dead-letter write is
          // allowed through so its recovery is observable.
          const isDeadLetter = b._patch?.response_body === "stuck_no_transition";
          if (opts.failureMode === "deadletter-ok" && isDeadLetter) {
            resolve({ data: [{ id: rows[0]?.id }], error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return b;
    },
  };
  return { db, counters, updates };
}

const stuckRow = (id = "del-1"): MockRow => ({
  id,
  order_id: "ord-1",
  payload: { type: "order.paid" },
  attempt_n: 0,
  status: "queued",
  orders: { merchants: { webhook_url: "https://example.com/wh", webhook_secret: "s", network: "testnet" } },
});

// Let queued microtasks settle so assertions observe a completed iteration.
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe("startWebhookWorker · spin protection (#242)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 503 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds the query rate for rows that cannot transition, and dead-letters them", async () => {
    // The delivery's own status writes silently fail (the #85 flavour of the
    // bug), but the circuit breaker's dead-letter write is allowed through so
    // the recovery is observable.
    const { db, counters, updates } = makeDb([stuckRow()], { failureMode: "deadletter-ok" });
    const stop = startWebhookWorker(db, true, { idlePollMs: 5_000, minIntervalMs: 100, stuckFetchLimit: 3 });
    await flush();

    // Before any sleep elapses the worker must not re-query.
    expect(counters.select).toBe(1);

    // 16s of simulated time: a no-progress batch backs off to idlePollMs, so
    // the worker issues only a handful of selects — not the thousands an
    // unbounded loop would issue over the same window.
    await vi.advanceTimersByTimeAsync(16_000);
    await flush();
    expect(counters.select).toBeGreaterThanOrEqual(2);
    expect(counters.select).toBeLessThanOrEqual(6);

    // Circuit breaker: the stuck delivery is dead-lettered with a loud alert.
    expect(updates.some(u => u.status === "dead" && u.response_body === "stuck_no_transition")).toBe(true);
    expect(lm.log).toHaveBeenCalledWith(
      "error",
      "webhook_delivery_stuck_dead",
      expect.objectContaining({ id: "del-1" }),
    );

    stop();
  });

  it("dead-letters after exactly stuckFetchLimit no-transition selections", async () => {
    const { db, counters, updates } = makeDb([stuckRow()]);
    const stop = startWebhookWorker(db, true, { idlePollMs: 1_000, minIntervalMs: 50, stuckFetchLimit: 3 });
    await flush();
    expect(counters.select).toBe(1);

    // Selections 2 and 3 only count toward the breaker.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(counters.select).toBe(2);
    expect(updates.filter(u => u.status === "dead" && u.response_body === "stuck_no_transition")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(counters.select).toBe(3);
    expect(updates.filter(u => u.status === "dead" && u.response_body === "stuck_no_transition")).toHaveLength(1);

    stop();
  });

  it("sleeps the minimum interval on iterations where rows were found and progressed", async () => {
    let seq = 0;
    const { db, counters } = makeDb([], {
      failureMode: "all-ok",
      provideRows: () => [{ ...stuckRow(`del-${++seq}`) }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

    const stop = startWebhookWorker(db, true, { idlePollMs: 5_000, minIntervalMs: 200, stuckFetchLimit: 3 });
    await flush();

    // Every batch delivers a fresh eligible row whose update succeeds. The old
    // code would spin through these as fast as the fetch+update round-trip; the
    // min interval now caps it at ~1 iteration per 200ms (~5 per second).
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(counters.select).toBeGreaterThanOrEqual(3);
    expect(counters.select).toBeLessThanOrEqual(8);

    stop();
  });

  it("keeps the empty-queue idle poll", async () => {
    const { db, counters } = makeDb([]);
    const stop = startWebhookWorker(db, true, { idlePollMs: 5_000, minIntervalMs: 100, stuckFetchLimit: 3 });
    await flush();
    expect(counters.select).toBe(1);

    // 4.9s: still within the idle window.
    await vi.advanceTimersByTimeAsync(4_900);
    await flush();
    expect(counters.select).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(counters.select).toBe(2);

    stop();
  });
});

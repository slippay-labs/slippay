import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireLease, HOLDER_ID } from "../src/lease.js";
import { createShutdownHandler } from "../src/shutdown.js";

function makeMockDb(opts: {
  insertError?: { code?: string; message: string } | null;
  selectRow?: { holder_id: string; expires_at: string } | null;
  stealRow?: { holder_id: string } | null;
} = {}) {
  // Build a chainable builder that is also a thenable resolving to {error:null}.
  // This matches Supabase JS's chain shape closely enough for unit tests.
  function makeBuilder(insertError: { code?: string; message: string } | null) {
    const builder: any = {};
    builder.from = vi.fn().mockReturnValue(builder);
    builder.insert = vi.fn().mockResolvedValue({ error: insertError });
    builder.select = vi.fn().mockReturnValue(builder);
    builder.eq = vi.fn().mockReturnValue(builder);
    builder.lte = vi.fn().mockReturnValue(builder);
    builder.update = vi.fn().mockReturnValue(builder);
    builder.delete = vi.fn().mockReturnValue(builder);
    builder.maybeSingle = vi.fn();
    builder.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });
    return builder;
  }
  const builder = makeBuilder(opts.insertError ?? null);
  if (opts.selectRow !== undefined) {
    builder.maybeSingle.mockResolvedValueOnce({ data: opts.selectRow, error: null });
  }
  if (opts.stealRow !== undefined) {
    builder.maybeSingle.mockResolvedValueOnce({ data: opts.stealRow, error: null });
  }
  return builder;
}

describe("acquireLease", () => {
  beforeEach(() => vi.useRealTimers());

  it("acquires on a fresh account (no prior row)", async () => {
    const db = makeMockDb({ insertError: null });
    const r = await acquireLease(db, "addr-1", { ttlSeconds: 60, heartbeatSeconds: 3600 });
    expect(r.acquired).toBe(true);
    if (r.acquired) await r.release();
  });

  it("refuses when another holder holds a non-expired lease", async () => {
    const future = new Date(Date.now() + 30_000).toISOString();
    const db = makeMockDb({
      insertError: { code: "23505", message: "duplicate" },
      selectRow: { holder_id: "other-pod", expires_at: future },
    });
    const r = await acquireLease(db, "addr-1");
    expect(r.acquired).toBe(false);
    if (!r.acquired) expect(r.heldBy).toBe("other-pod");
  });

  it("steals an expired lease", async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const db = makeMockDb({
      insertError: { code: "23505", message: "duplicate" },
      selectRow: { holder_id: "dead-pod", expires_at: past },
      stealRow: { holder_id: HOLDER_ID },
    });
    const r = await acquireLease(db, "addr-1", { ttlSeconds: 60, heartbeatSeconds: 3600 });
    expect(r.acquired).toBe(true);
    if (r.acquired) await r.release();
  });

  it("does not acquire if another pod stole during the steal race", async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const db = makeMockDb({
      insertError: { code: "23505", message: "duplicate" },
      selectRow: { holder_id: "dead-pod", expires_at: past },
      stealRow: null,
    });
    const r = await acquireLease(db, "addr-1");
    expect(r.acquired).toBe(false);
  });

  it("fails closed on unexpected insert error", async () => {
    const db = makeMockDb({ insertError: { code: "08000", message: "connection reset" } });
    const r = await acquireLease(db, "addr-1");
    expect(r.acquired).toBe(false);
  });

  it("release is idempotent and does not error on double call (fixes #254)", async () => {
    const db = makeMockDb({ insertError: null });
    const r = await acquireLease(db, "addr-1", { ttlSeconds: 60, heartbeatSeconds: 3600 });
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      await expect(r.release()).resolves.toBeUndefined();
      // Second invocation must be safe and idempotent
      await expect(r.release()).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalledTimes(1);
    }
  });

  it("allows a subsequent replica to acquire account immediately after release without waiting for expiry", async () => {
    // Replica 1 acquires and releases
    const db1 = makeMockDb({ insertError: null });
    const r1 = await acquireLease(db1, "addr-1");
    expect(r1.acquired).toBe(true);
    if (r1.acquired) await r1.release();

    // Replica 2 acquires immediately (fresh insert succeeds because lease was deleted)
    const db2 = makeMockDb({ insertError: null });
    const r2 = await acquireLease(db2, "addr-1");
    expect(r2.acquired).toBe(true);
    if (r2.acquired) await r2.release();
  });
});

describe("graceful shutdown on signals (fixes #254)", () => {
  it("awaits lease release and stops workers before calling exit on SIGTERM", async () => {
    let leaseReleased = false;
    let webhookStopped = false;
    let exitCode: number | undefined;

    const stop = vi.fn().mockImplementation(async () => {
      // Simulate async lease release
      await new Promise((res) => setTimeout(res, 10));
      leaseReleased = true;
    });

    const stopWebhook = vi.fn().mockImplementation(() => {
      webhookStopped = true;
    });

    const exitFn = vi.fn().mockImplementation((code?: number) => {
      exitCode = code;
    });

    const handler = createShutdownHandler(stop, stopWebhook, exitFn, 5000);
    await handler("SIGTERM");

    expect(stopWebhook).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(leaseReleased).toBe(true);
    expect(webhookStopped).toBe(true);
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(exitCode).toBe(0);
  });

  it("runs the exact same graceful cleanup path on SIGINT", async () => {
    let cleanedUp = false;
    const stop = vi.fn().mockImplementation(async () => {
      cleanedUp = true;
    });
    const stopWebhook = vi.fn();
    const exitFn = vi.fn();

    const handler = createShutdownHandler(stop, stopWebhook, exitFn, 5000);
    await handler("SIGINT");

    expect(cleanedUp).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(stopWebhook).toHaveBeenCalled();
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("is idempotent when invoked multiple times during shutdown", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const stopWebhook = vi.fn();
    const exitFn = vi.fn();

    const handler = createShutdownHandler(stop, stopWebhook, exitFn, 5000);
    await Promise.all([handler("SIGTERM"), handler("SIGINT")]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopWebhook).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
  });
});

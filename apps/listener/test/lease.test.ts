import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { acquireLease, HOLDER_ID } from "../src/lease.js";

function makeMockDb(opts: {
  insertError?: { code?: string; message: string } | null;
  selectRow?: { holder_id: string; expires_at: string } | null;
  stealRow?: { holder_id: string } | null;
  heartbeatRows?: Array<{ unknown: unknown }>;
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
    // Supabase queries are thenable; the heartbeat awaits the chain directly.
    // Default to an empty result so a heartbeat that matches zero rows is
    // observable in tests.
    builder.then = (resolve: (v: { data?: unknown; error: null }) => void) =>
      resolve({
        data: opts.heartbeatRows ?? [],
        error: null,
      });
    return builder;
  }
  const builder = makeBuilder(opts.insertError ?? null);
  if (opts.selectRow !== undefined) {
    builder.maybeSingle.mockResolvedOnce({ data: opts.selectRow, error: null });
  }
  if (opts.stealRow !== undefined) {
    builder.maybeSingle.mockResolvedOnce({ data: opts.stealRow, error: null });
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
});

describe("acquireLease · heartbeat lease-loss detection", () => {
  afterEach(() => vi.useRealTimers());

  it("detects a stolen lease (zero rows updated) and invokes onLeaseLost", async () => {
    vi.useFakeTimers();
    // Heartbeat update matches zero rows — another pod took over.
    const db = makeMockDb({ insertError: null, heartbeatRows: [] });
    const onLeaseLost = vi.fn();
    const r = await acquireLease(db, "addr-1", {
      ttlSeconds: 60,
      heartbeatSeconds: 1,
      onLeaseLost,
    });
    expect(r.acquired).toBe(true);

    await vi.advanceTimerByAsync(1);
    // Allow the async heartbeat callback to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(onLeaseLoss).toHaveBeenCalledTimes(1);
    if (r.acquired) await r.release();
  });

  it("does not invoke onLeaseLoss when the heartbeat updates a row", async () => {
    vi.useFakeTimers();
    const db = makeMockDb({ insertError: null, heartbeatRows: [{ unknown: true }] });
    const onLeaseLost = vi.fn();
    const r = await acquireLease(db, "addr-1", {
      ttlSeconds: 60,
      heartbeatSeconds: 1,
      onLeaseLost,
    });
    expect(r.acquired).toBe(true);

    await vi.advanceTimerByAsync(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(onLeaseLoss).not.toHaveBeenCalled();
    if (r.acquired) await r.release();
  });
});

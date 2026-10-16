import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireLease, HOLDER_ID } from "../src/lease.js";

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
    builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [{ holder_id: HOLDER_ID }], error: null });
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

  it("detects lost lease when heartbeat matches 0 rows, emits alert error log, and invokes onLost", async () => {
    vi.useFakeTimers();
    let onLostCalled = false;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockResolvedValue({ error: null });
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.select = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);

    // Heartbeat update resolves with empty rows (0 rows matched)
    chain.then = (resolve: (v: any) => void) => resolve({ data: [], error: null });

    const lease = await acquireLease(chain, "addr-lost", {
      ttlSeconds: 60,
      heartbeatSeconds: 10,
      onLost: () => {
        onLostCalled = true;
      },
    });
    expect(lease.acquired).toBe(true);
    expect(onLostCalled).toBe(false);

    // Advance 10s to fire heartbeat
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onLostCalled).toBe(true);

    // Verify alert level error log
    const errorLogs = consoleSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.msg === "lease_lost");

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0].level).toBe("error");
    expect(errorLogs[0].account_id).toBe("addr-lost");
    expect(errorLogs[0].holder_id).toBe(HOLDER_ID);

    if (lease.acquired) await lease.release();
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });
});

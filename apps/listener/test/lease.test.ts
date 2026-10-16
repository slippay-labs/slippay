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
    builder.lt = vi.fn().mockReturnValue(builder);
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
});

describe("lease heartbeat safety and concurrency", () => {
  beforeEach(() => vi.useRealTimers());

  it("prevents overlapping ticks and logs lease_heartbeat_skipped when an update is in-flight", async () => {
    const updateResolvers: Array<() => void> = [];
    let concurrentUpdates = 0;
    let maxConcurrent = 0;

    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockResolvedValue({ error: null });
    chain.select = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.lte = vi.fn().mockReturnValue(chain);
    chain.lt = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn();

    let inUpdateMode = false;
    chain.update = vi.fn().mockImplementation(() => {
      inUpdateMode = true;
      concurrentUpdates++;
      if (concurrentUpdates > maxConcurrent) {
        maxConcurrent = concurrentUpdates;
      }
      return chain;
    });

    chain.then = (resolve: (v: { error: null }) => void) => {
      if (inUpdateMode) {
        inUpdateMode = false;
        updateResolvers.push(() => {
          concurrentUpdates--;
          resolve({ error: null });
        });
      } else {
        resolve({ error: null });
      }
    };

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const lease = await acquireLease(chain, "addr-overlap", {
      ttlSeconds: 60,
      heartbeatSeconds: 3600,
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    // Trigger first heartbeat: it hangs in flight
    const hbPromise1 = lease.heartbeat!();
    await Promise.resolve(); // let microtasks run to invoke update and then()

    // Trigger second heartbeat while first is in-flight
    const hbPromise2 = lease.heartbeat!();

    // Trigger third heartbeat while first is still in-flight
    const hbPromise3 = lease.heartbeat!();

    await Promise.all([hbPromise2, hbPromise3]);

    // Assert that in-flight updates never exceeded 1
    expect(maxConcurrent).toBe(1);
    expect(concurrentUpdates).toBe(1);

    // Verify skipped tick log was emitted
    const skippedLogs = consoleSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.msg === "lease_heartbeat_skipped");

    expect(skippedLogs.length).toBeGreaterThanOrEqual(1);
    expect(skippedLogs[0].account_id).toBe("addr-overlap");
    expect(skippedLogs[0].holder_id).toBe(HOLDER_ID);
    expect(skippedLogs[0].reason).toBe("heartbeat_in_flight");

    // Resolve the first in-flight heartbeat
    updateResolvers.forEach((r) => r());
    await hbPromise1;

    expect(concurrentUpdates).toBe(0);

    await lease.release();
    consoleSpy.mockRestore();
  });

  it("monotonic write guard prevents out-of-order writes from shortening expires_at", async () => {
    let storedExpiresAt = "2026-10-16T12:00:00.000Z";

    interface PendingWrite {
      proposedExpires: string;
      ltCondition: string;
      executeDbWrite: () => void;
    }
    const pendingWrites: PendingWrite[] = [];

    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockResolvedValue({ error: null });
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.lte = vi.fn().mockReturnValue(chain);

    let currentLt = "";
    chain.lt = vi.fn().mockImplementation((col: string, val: string) => {
      currentLt = val;
      return chain;
    });

    let currentUpdatePayload: { expires_at: string } | null = null;
    chain.update = vi.fn().mockImplementation((payload: { expires_at: string }) => {
      currentUpdatePayload = payload;
      return chain;
    });

    chain.then = (resolve: (val: { error: null }) => void) => {
      if (currentUpdatePayload) {
        const payload = currentUpdatePayload;
        const ltVal = currentLt;
        currentUpdatePayload = null;
        currentLt = "";

        pendingWrites.push({
          proposedExpires: payload.expires_at,
          ltCondition: ltVal,
          executeDbWrite: () => {
            // Simulated Postgres conditional update:
            // WHERE expires_at < nextExpires
            if (!ltVal || storedExpiresAt < ltVal) {
              storedExpiresAt = payload.expires_at;
            }
            resolve({ error: null });
          },
        });
      } else {
        resolve({ error: null });
      }
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));

    const lease = await acquireLease(chain, "addr-monotonic", {
      ttlSeconds: 60,
      heartbeatSeconds: 3600,
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    // Trigger Write A at simulated 12:00:10 (proposes 12:01:10)
    vi.setSystemTime(new Date("2026-10-16T12:00:10.000Z"));
    const hbA = lease.heartbeat!();
    await Promise.resolve(); // drain microtask to enqueue write
    expect(pendingWrites.length).toBe(1);
    const writeA = pendingWrites[0];
    expect(writeA.proposedExpires).toBe("2026-10-16T12:01:10.000Z");

    // Let Write A finish resolving so in-flight clear
    writeA.executeDbWrite();
    await hbA;
    expect(storedExpiresAt).toBe("2026-10-16T12:01:10.000Z");

    // Trigger Write B at simulated 12:00:20 (proposes 12:01:20)
    vi.setSystemTime(new Date("2026-10-16T12:00:20.000Z"));
    const hbB = lease.heartbeat!();
    await Promise.resolve(); // drain microtask
    expect(pendingWrites.length).toBe(2);
    const writeB = pendingWrites[1];
    expect(writeB.proposedExpires).toBe("2026-10-16T12:01:20.000Z");

    // Commit Write B
    writeB.executeDbWrite();
    await hbB;
    expect(storedExpiresAt).toBe("2026-10-16T12:01:20.000Z");

    // Now simulate an out-of-order delayed replay of Write A arriving late at database
    // Because storedExpiresAt is 12:01:20, and writeA.ltCondition is 12:01:10,
    // condition storedExpiresAt < writeA.ltCondition is FALSE.
    writeA.executeDbWrite();

    // Stored expiration must NOT be shortened
    expect(storedExpiresAt).toBe("2026-10-16T12:01:20.000Z");

    await lease.release();
    vi.useRealTimers();
  });

  it("self-schedules subsequent heartbeats using setTimeout", async () => {
    vi.useFakeTimers();
    let heartbeatCount = 0;

    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockResolvedValue({ error: null });
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.lte = vi.fn().mockReturnValue(chain);
    chain.lt = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockImplementation(() => {
      heartbeatCount++;
      return chain;
    });
    chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });

    const lease = await acquireLease(chain, "addr-chain", {
      ttlSeconds: 60,
      heartbeatSeconds: 10,
    });
    expect(lease.acquired).toBe(true);
    expect(heartbeatCount).toBe(0);

    // Advance 10 seconds -> first auto tick
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeatCount).toBe(1);

    // Advance 10 seconds -> second auto tick
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeatCount).toBe(2);

    if (lease.acquired) await lease.release();

    // After release, no further heartbeat ticks
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeatCount).toBe(2);

    vi.useRealTimers();
  });
});


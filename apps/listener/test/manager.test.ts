import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  watchAccount: vi.fn(),
  acquireLease: vi.fn(),
  log: vi.fn(),
  config: { merchantNetwork: "testnet", network: "TESTNET", merchantPollMs: 1_000 },
}));

vi.mock("../src/horizon.js", () => ({ watchAccount: m.watchAccount }));
vi.mock("../src/log.js", () => ({ log: m.log }));
vi.mock("../src/config.js", () => ({ config: m.config }));
vi.mock("../src/lease.js", () => ({ acquireLease: m.acquireLease }));

import { startManager } from "../src/manager.js";

// Faked `merchants` query: the Supabase builder is a thenable resolving to the
// rows set by the test.
let merchants: { stellar_address: string }[] = [];

const db: any = {
  from: (_table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      not: () => b,
      then: (resolve: (v: unknown) => void) => resolve({ data: merchants, error: null }),
    };
    return b;
  },
};

type Fn = ReturnType<typeof vi.fn>;
let stops: Record<string, Fn>;
let releases: Record<string, Fn>;

function seed(active: string[]): void {
  merchants = active.map((stellar_address) => ({ stellar_address }));
  stops = {};
  releases = {};
  m.watchAccount.mockImplementation(async ({ accountId }: { accountId: string }) => {
    stops[accountId] = vi.fn();
    return stops[accountId];
  });
  m.acquireLease.mockImplementation(async (_db: unknown, addr: string) => {
    releases[addr] = vi.fn(async () => undefined);
    return { acquired: true, release: releases[addr] };
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const poll = () => vi.advanceTimersByTimeAsync(1_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  seed([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startManager · desired-vs-running reconciliation", () => {
  it("starts a stream for a newly-added merchant and is a no-op when the set is unchanged", async () => {
    seed(["A"]);
    const shutdown = startManager(db);
    await flush();

    expect(m.watchAccount).toHaveBeenCalledTimes(1);
    expect(m.watchAccount).toHaveBeenCalledWith({ db, network: "TESTNET", accountId: "A" });
    expect(m.acquireLease).toHaveBeenCalledTimes(1);

    // Same merchant set on the next poll — no new stream, no new lease.
    await poll();
    expect(m.watchAccount).toHaveBeenCalledTimes(1);
    expect(m.acquireLease).toHaveBeenCalledTimes(1);

    await shutdown();
  });

  it("starts a stream for an added merchant and tears down a removed one", async () => {
    seed(["A"]);
    const shutdown = startManager(db);
    await flush();

    merchants = [{ stellar_address: "A" }, { stellar_address: "B" }];
    await poll();
    expect(m.watchAccount).toHaveBeenCalledTimes(2);
    expect(typeof stops.B).toBe("function");

    merchants = [{ stellar_address: "B" }];
    await poll();
    expect(stops.A).toHaveBeenCalledTimes(1);
    expect(releases.A).toHaveBeenCalledTimes(1);

    await shutdown();
    expect(stops.B).toHaveBeenCalledTimes(1);
  });
});

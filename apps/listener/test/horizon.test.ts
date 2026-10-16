import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A controllable stand-in for `Horizon.Server`: every call() pops the next page
// from a queue and records the (order, limit, cursor) the module asked with.
const hz = vi.hoisted(() => {
  const calls: { order: string; limit: number; cursor?: string }[] = [];
  let queue: any[] = [];
  const cur: { order: string; limit: number; cursor?: string } = { order: "asc", limit: 0 };
  const builder: any = {
    forAccount: () => builder,
    order: (o: string) => { cur.order = o; return builder; },
    limit: (n: number) => { cur.limit = n; return builder; },
    cursor: (c: string) => { cur.cursor = c; return builder; },
    call: async () => {
      const entry: { order: string; limit: number; cursor?: string } = { order: cur.order, limit: cur.limit };
      if (cur.cursor !== undefined) entry.cursor = cur.cursor;
      calls.push(entry);
      const page = queue.shift() ?? { records: [] };
      cur.order = "asc"; cur.limit = 0; delete cur.cursor;
      return page;
    },
  };
  const Server = class { constructor(_url: string) {} payments() { return builder; } };
  return {
    calls,
    Server,
    setQueue(q: any[]) { queue = q; },
    reset() { calls.length = 0; queue = []; cur.order = "asc"; cur.limit = 0; delete cur.cursor; },
  };
});

vi.mock("@stellar/stellar-sdk", () => ({ Horizon: { Server: hz.Server } }));
vi.mock("../src/matcher.js", () => ({ matchPaymentToOrder: vi.fn(() => ({ outcome: "ignore" })) }));
vi.mock("../src/reconciler.js", () => ({ reconcileMatch: vi.fn(async () => undefined) }));
vi.mock("../src/log.js", () => ({ log: vi.fn() }));

import { watchAccount, resolveOrderFeeBp } from "../src/horizon.js";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";
import { matchPaymentToOrder } from "../src/matcher.js";
import { log } from "../src/log.js";

// --- db stub: enough of the Supabase chain for listener_state + orders -------
const stateRow = { current: null as null | { paging_token: string } };
const orderRow = { current: null as any };
const upserted: { account_id: string; paging_token: string }[] = [];

const db: any = {
  from: (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "listener_state"
              ? stateRow.current
              : table === "orders"
                ? orderRow.current
                : null,
          error: null,
        }),
      upsert: (row: any) => {
        if (table === "listener_state") upserted.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return b;
  },
};

const ACCOUNT = "G" + "M".repeat(55);
const headPage = (token: string) => ({ records: [{ type: "payment", paging_token: token }] });

function paymentRecord(token: string) {
  return {
    type: "payment",
    paging_token: token,
    asset_code: "USDC",
    asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    to: ACCOUNT,
    amount: "1.0000000",
    transaction_hash: `hash-${token}`,
    transaction: async () => ({ memo_type: "hash", memo: Buffer.from("00".repeat(32), "hex").toString("base64"), successful: true }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hz.reset();
  stateRow.current = null;
  orderRow.current = null;
  upserted.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchAccount · resume cursor", () => {
  it("starts at the current head when no cursor is stored", async () => {
    hz.setQueue([headPage("100"), { records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);

    expect(hz.calls[0]).toEqual({ order: "desc", limit: 1 });
    // The very first poll is anchored on the head token, and it ascends.
    expect(hz.calls[1]).toEqual({ order: "asc", limit: 200, cursor: "100" });
    stop();
  });

  it("resumes from the stored cursor instead of re-fetching head (no replay)", async () => {
    stateRow.current = { paging_token: "55" };
    hz.setQueue([{ records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);

    expect(hz.calls).toHaveLength(1);
    expect(hz.calls[0]).toMatchObject({ order: "asc", cursor: "55" });
    expect(hz.calls.some((c) => c.order === "desc")).toBe(false);
    stop();
  });
});

describe("watchAccount · cursor paging (duplicate + out-of-order)", () => {
  it("advances the paging token monotonically and persists every record's token", async () => {
    stateRow.current = { paging_token: "10" };
    hz.setQueue([{ records: [paymentRecord("11"), paymentRecord("12")] }, { records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);

    expect(upserted.map((u) => u.paging_token)).toEqual(["11", "12"]);
    expect(upserted.every((u) => u.account_id === ACCOUNT)).toBe(true);
    stop();
  });

  it("passes the last token as the next cursor, so a consumed page is not re-requested", async () => {
    stateRow.current = { paging_token: "12" };
    hz.setQueue([{ records: [paymentRecord("13")] }, { records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000); // next poll

    // Second upstream request resumes strictly after the last consumed token.
    expect(hz.calls[1]).toMatchObject({ order: "asc", cursor: "13" });
    // ...and the empty second page adds nothing.
    expect(upserted.map((u) => u.paging_token)).toEqual(["13"]);
    stop();
  });

  it("keeps the last Horizon token across a non-contiguous token gap (does not reset to head)", async () => {
    stateRow.current = { paging_token: "20" };
    hz.setQueue([{ records: [paymentRecord("21"), paymentRecord("30"), paymentRecord("40")] }, { records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(upserted.map((u) => u.paging_token)).toEqual(["21", "30", "40"]);
    // next request is anchored on the highest token seen, not on the head.
    expect(hz.calls[1]).toMatchObject({ cursor: "40" });
    stop();
  });

  it("handles a page that repeats a token by leaving the cursor idempotent", async () => {
    stateRow.current = { paging_token: "50" };
    hz.setQueue([{ records: [paymentRecord("50"), paymentRecord("50")] }, { records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(upserted.map((u) => u.paging_token)).toEqual(["50", "50"]);
    expect(hz.calls[1]).toMatchObject({ cursor: "50" });
    stop();
  });
});

describe("watchAccount · shutdown", () => {
  it("stops polling after the returned stop() is called", async () => {
    stateRow.current = { paging_token: "1" };
    hz.setQueue([{ records: [] }]);
    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);
    const before = hz.calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hz.calls.length).toBe(before);
  });
});

describe("resolveOrderFeeBp (Issue #231)", () => {
  it("uses order.platform_fee_bp when explicitly defined", () => {
    const fee = resolveOrderFeeBp({ platform_fee_bp: 150 });
    expect(fee).toBe(150);
    expect(log).not.toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.anything());
  });

  it("falls back to merchant.platform_fee_bp when order rate is null", () => {
    const fee = resolveOrderFeeBp({ platform_fee_bp: null }, { platform_fee_bp: 250 });
    expect(fee).toBe(250);
    expect(log).not.toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.anything());
  });

  it("never falls back to zero when both order and merchant rates are null/undefined; uses canonical DEFAULT_PLATFORM_FEE_BP and alerts", () => {
    const fee = resolveOrderFeeBp({ id: "ord-123", merchant_id: "m-456", platform_fee_bp: null }, { platform_fee_bp: null });
    expect(fee).toBe(DEFAULT_PLATFORM_FEE_BP);
    expect(fee).toBe(297);
    expect(log).toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.objectContaining({
      order_id: "ord-123",
      merchant_id: "m-456",
      fallback_fee_bp: 297,
    }));
  });

  it("handles empty objects or NaN safely with DEFAULT_PLATFORM_FEE_BP and alerts", () => {
    const fee = resolveOrderFeeBp({}, undefined);
    expect(fee).toBe(DEFAULT_PLATFORM_FEE_BP);
    expect(fee).toBe(297);
    expect(log).toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.anything());
  });
});

describe("watchAccount · fee resolution in payment processing (Issue #231)", () => {
  it("passes DEFAULT_PLATFORM_FEE_BP (not 0) to matcher when an order has null platform_fee_bp", async () => {
    stateRow.current = { paging_token: "100" };
    orderRow.current = {
      id: "ord-null-fee",
      merchant_id: "m-null-fee",
      memo: "00".repeat(32),
      usdc_amount: "10.0000000",
      platform_fee_bp: null,
      merchants: {
        stellar_address: ACCOUNT,
        platform_fee_bp: null,
      },
    };

    hz.setQueue([
      { records: [paymentRecord("101")] },
      { records: [] },
    ]);

    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);

    expect(matchPaymentToOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "ord-null-fee",
        platform_fee_bp: DEFAULT_PLATFORM_FEE_BP,
      }),
      "TESTNET"
    );

    expect(log).toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.objectContaining({
      order_id: "ord-null-fee",
      merchant_id: "m-null-fee",
      fallback_fee_bp: 297,
    }));

    stop();
  });

  it("preserves explicit fee basis points when configured on the order", async () => {
    stateRow.current = { paging_token: "200" };
    orderRow.current = {
      id: "ord-custom-fee",
      merchant_id: "m-custom",
      memo: "00".repeat(32),
      usdc_amount: "10.0000000",
      platform_fee_bp: 150,
      merchants: {
        stellar_address: ACCOUNT,
        platform_fee_bp: 150,
      },
    };

    hz.setQueue([
      { records: [paymentRecord("201")] },
      { records: [] },
    ]);

    const stop = await watchAccount({ db, network: "TESTNET", accountId: ACCOUNT });
    await vi.advanceTimersByTimeAsync(0);

    expect(matchPaymentToOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "ord-custom-fee",
        platform_fee_bp: 150,
      }),
      "TESTNET"
    );

    expect(log).not.toHaveBeenCalledWith("alert", "order_missing_fee_basis_point", expect.anything());

    stop();
  });
});


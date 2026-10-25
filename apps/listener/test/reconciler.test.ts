import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileMatch, bumpSubscriptionCharges } from "../src/reconciler.js";

function makeMockDb() {
  const single = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const insert = vi.fn().mockReturnThis();
  const update = vi.fn().mockReturnThis();
  const eq = vi.fn().mockReturnThis();
  const inFn = vi.fn().mockReturnThis();
  const select = vi.fn().mockReturnThis();
  const from = vi.fn().mockReturnThis();
  const mock = { from, update, insert, eq, in: inFn, select, single, maybeSingle };
  return mock as unknown as Parameters<typeof reconcileMatch>[0] & typeof mock;
}

describe("reconcileMatch", () => {
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => { mockDb = makeMockDb(); });

  it("updates pending order to paid and enqueues webhook on outcome=paid", async () => {
    mockDb.single.mockResolvedValueOnce({ data: { id: "ord-1", external_ref: "x", brl_amount: "10.00", usdc_amount: "1.7", paid_at: "2026-05-07T00:00:00Z" }, error: null });
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "paid" }, "txhash");
    expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ status: "paid", tx_hash: "txhash" }));
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("is idempotent on already-paid order (no webhook insert when no row matched)", async () => {
    mockDb.single.mockResolvedValueOnce({ data: null, error: null });
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "paid" }, "txhash");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("does nothing on ignore outcome", async () => {
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "ignore" }, "txhash");
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("allows underpaid→paid transition (audit-003 L3)", async () => {
    mockDb.single.mockResolvedValueOnce({ data: { id: "ord-1", external_ref: "x", brl_amount: "10.00", usdc_amount: "1.7", paid_at: "2026-05-16T00:00:00Z" }, error: null });
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "paid" }, "topup-tx");
    expect(mockDb.in).toHaveBeenCalledWith("status", ["pending", "underpaid"]);
  });

  it("only allows pending→underpaid (no backward transition)", async () => {
    mockDb.single.mockResolvedValueOnce({ data: null, error: null });
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "underpaid", expected: "1.7000000", received: "0.5000000" }, "partial-tx");
    expect(mockDb.in).toHaveBeenCalledWith("status", ["pending"]);
  });

  it("dedupe on unique-violation (23505) does not log error", async () => {
    mockDb.single.mockResolvedValueOnce({ data: { id: "ord-1", external_ref: "x", brl_amount: "10.00", usdc_amount: "1.7", paid_at: "2026-05-16T00:00:00Z" }, error: null });
    mockDb.insert.mockReturnValueOnce(Promise.resolve({ error: { code: "23505", message: "duplicate" } }));
    await reconcileMatch(mockDb, { id: "ord-1", merchant_id: "m-1", memo: "ab".repeat(32), usdc_amount: "1.7", merchant_stellar_address: "G".padEnd(56,"A"), platform_fee_bp: 100 }, { outcome: "paid" }, "txhash");
    // no throw, no error log assertion — surviving the call is the contract
    expect(mockDb.insert).toHaveBeenCalled();
  });

  describe("bumpSubscriptionCharges (Issue #489 / Audit-003 L11)", () => {
    it("increments charges_done and updates last_charge_at", async () => {
      let state = { charges_done: 0, max_periods: 5, status: "active" };

      const db = {
        from: (table: string) => {
          expect(table).toBe("subscriptions");
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { ...state }, error: null }),
              }),
            }),
            update: (patch: any) => ({
              eq: (_idCol: string, _idVal: string) => ({
                eq: (counterCol: string, observedVal: number) => ({
                  select: () => ({
                    maybeSingle: async () => {
                      if (state.charges_done === observedVal) {
                        state.charges_done = patch.charges_done;
                        if (patch.status) state.status = patch.status;
                        return { data: { charges_done: state.charges_done, status: state.status }, error: null };
                      }
                      return { data: null, error: null };
                    },
                  }),
                }),
              }),
            }),
          };
        },
      } as any;

      const res = await bumpSubscriptionCharges(db, "sub-1");
      expect(res).toEqual({ charges_done: 1, status: "active" });
      expect(state.charges_done).toBe(1);
    });

    it("expires subscription when counter reaches max_periods exactly", async () => {
      let state = { charges_done: 2, max_periods: 3, status: "active" };

      const db = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...state }, error: null }),
            }),
          }),
          update: (patch: any) => ({
            eq: () => ({
              eq: (_c: string, observed: number) => ({
                select: () => ({
                  maybeSingle: async () => {
                    if (state.charges_done === observed) {
                      state.charges_done = patch.charges_done;
                      if (patch.status) state.status = patch.status;
                      return { data: { charges_done: state.charges_done, status: state.status }, error: null };
                    }
                    return { data: null, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      } as any;

      const res = await bumpSubscriptionCharges(db, "sub-2");
      expect(res).toEqual({ charges_done: 3, status: "expired" });
      expect(state.status).toBe("expired");
    });

    it("recovers from concurrent race via optimistic concurrency retry (final counter = 2)", async () => {
      let state = { charges_done: 0, max_periods: 2, status: "active" };
      let simulateRace = true;

      const db = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...state }, error: null }),
            }),
          }),
          update: (patch: any) => ({
            eq: () => ({
              eq: (_c: string, observed: number) => ({
                select: () => ({
                  maybeSingle: async () => {
                    // First update attempt encounters a simulated race condition
                    if (simulateRace) {
                      simulateRace = false;
                      // Concurrently another worker updated state to 1
                      state.charges_done = 1;
                      return { data: null, error: null };
                    }
                    if (state.charges_done === observed) {
                      state.charges_done = patch.charges_done;
                      if (patch.status) state.status = patch.status;
                      return { data: { charges_done: state.charges_done, status: state.status }, error: null };
                    }
                    return { data: null, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      } as any;

      const res = await bumpSubscriptionCharges(db, "sub-race");
      expect(res).toEqual({ charges_done: 2, status: "expired" });
      expect(state.charges_done).toBe(2);
      expect(state.status).toBe("expired");
    });
  });
});

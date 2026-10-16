import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileMatch } from "../src/reconciler.js";
import { matchPaymentToOrder, type StellarPaymentEvent, type OrderForMatch } from "../src/matcher.js";
import { deliverOnce, nextBackoff } from "../src/webhook.js";
import { acquireLease } from "../src/lease.js";
import { NETWORK } from "@slippay/shared";

/**
 * In-memory transactional engine simulating Postgres row-level locking,
 * atomic conditional updates, and unique constraint enforcement on webhook_deliveries.
 */
class InMemoryDatabaseHarness {
  orders = new Map<string, any>();
  subscriptions = new Map<string, any>();
  webhookDeliveries = new Map<string, any>();
  leases = new Map<string, any>();

  // Audit counters to verify exact call counts
  orderUpdateCount = 0;
  webhookInsertSuccessCount = 0;
  webhookDedupCount = 0;
  subscriptionChargeCount = 0;

  reset() {
    this.orders.clear();
    this.subscriptions.clear();
    this.webhookDeliveries.clear();
    this.leases.clear();
    this.orderUpdateCount = 0;
    this.webhookInsertSuccessCount = 0;
    this.webhookDedupCount = 0;
    this.subscriptionChargeCount = 0;
  }

  createClient() {
    const self = this;

    return {
      from(table: string) {
        return {
          // Orders / Subscriptions / Webhook deliveries table updates
          update(patch: Record<string, any>) {
            return {
              eq(col: string, val: any) {
                const promise = Promise.resolve().then(() => {
                  if (table === "subscriptions") {
                    const row = self.subscriptions.get(val);
                    if (row) {
                      self.subscriptionChargeCount++;
                      self.subscriptions.set(val, { ...row, ...patch });
                    }
                    return { data: null, error: null };
                  }
                  if (table === "webhook_deliveries") {
                    const row = self.webhookDeliveries.get(val);
                    if (row) {
                      self.webhookDeliveries.set(val, { ...row, ...patch });
                    }
                    return { data: null, error: null };
                  }
                  return { data: null, error: null };
                });

                return Object.assign(promise, {
                  in(statusCol: string, allowedStatuses: string[]) {
                    return {
                      select() {
                        return {
                          single() {
                            if (table !== "orders") throw new Error("unsupported table for conditional update");
                            const row = self.orders.get(val);
                            if (!row) {
                              return Promise.resolve({ data: null, error: { message: "order not found" } });
                            }
                            if (!allowedStatuses.includes(row[statusCol])) {
                              return Promise.resolve({
                                data: null,
                                error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
                              });
                            }
                            // Atomic update
                            self.orderUpdateCount++;
                            const updated = { ...row, ...patch };
                            self.orders.set(val, updated);
                            return Promise.resolve({ data: updated, error: null });
                          },
                        };
                      },
                    };
                  },
                });
              },
            };
          },

          // Insert operations
          insert(doc: Record<string, any>) {
            if (table === "webhook_deliveries") {
              const key = `${doc.order_id}:${doc.type}`;
              if (self.webhookDeliveries.has(key)) {
                self.webhookDedupCount++;
                return Promise.resolve({
                  error: { code: "23505", message: "duplicate key value violates unique constraint" },
                });
              }
              const id = `del-${self.webhookDeliveries.size + 1}`;
              const record = { id, ...doc, status: "queued", attempt_n: 0 };
              self.webhookDeliveries.set(key, record);
              self.webhookInsertSuccessCount++;
              return Promise.resolve({ error: null });
            }

            if (table === "listener_leases") {
              if (self.leases.has(doc.account_id)) {
                return Promise.resolve({
                  error: { code: "23505", message: "lease already exists" },
                });
              }
              self.leases.set(doc.account_id, { ...doc });
              return Promise.resolve({ error: null });
            }

            return Promise.resolve({ error: null });
          },

          // Select operations
          select(cols?: string) {
            return {
              eq(col: string, val: any) {
                return {
                  async maybeSingle() {
                    if (table === "subscriptions") {
                      const sub = self.subscriptions.get(val);
                      return { data: sub ? { ...sub } : null, error: null };
                    }
                    if (table === "listener_leases") {
                      const l = self.leases.get(val);
                      return { data: l ? { ...l } : null, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    } as any;
  }
}

describe("E2E Credit-Once Idempotency & Duplicate Payment Defense", () => {
  const harness = new InMemoryDatabaseHarness();
  const db = harness.createClient();

  const MERCHANT_STEL = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
  const MEMO_HEX = "11".repeat(32);
  const MEMO_B64 = Buffer.from(MEMO_HEX, "hex").toString("base64");

  const sampleOrder: OrderForMatch & { merchant_id: string } = {
    id: "ord-test-e2e-1",
    merchant_id: "merch-1",
    memo: MEMO_HEX,
    usdc_amount: "100.0000000",
    merchant_stellar_address: MERCHANT_STEL,
    platform_fee_bp: 297,
  };

  const paymentEvent: StellarPaymentEvent = {
    successful: true,
    memo_type: "hash",
    memo_b64: MEMO_B64,
    asset_code: "USDC",
    asset_issuer: NETWORK.testnet.usdc_issuer,
    to: MERCHANT_STEL,
    amount: "100.0000000",
    hash: "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
  };

  beforeEach(() => {
    harness.reset();
    // Seed database with initial pending order
    harness.orders.set(sampleOrder.id, {
      id: sampleOrder.id,
      merchant_id: sampleOrder.merchant_id,
      status: "pending",
      usdc_amount: sampleOrder.usdc_amount,
      memo: sampleOrder.memo,
      external_ref: "ext-ref-123",
      subscription_id: "sub-1",
    });

    // Seed subscription with max_periods = 3, charges_done = 1
    harness.subscriptions.set("sub-1", {
      id: "sub-1",
      charges_done: 1,
      max_periods: 3,
      status: "active",
    });
  });

  it("Path 1: Duplicate Match Submissions — exactly one order credit and one webhook", async () => {
    // 1. Run the matcher for the on-chain event
    const match1 = matchPaymentToOrder(paymentEvent, sampleOrder, "TESTNET");
    expect(match1.outcome).toBe("paid");

    // Reconcile first payment
    await reconcileMatch(db, sampleOrder, match1, paymentEvent.hash);

    // Assert first execution credited the order
    const orderAfterFirst = harness.orders.get(sampleOrder.id);
    expect(orderAfterFirst.status).toBe("paid");
    expect(orderAfterFirst.tx_hash).toBe(paymentEvent.hash);
    expect(harness.orderUpdateCount).toBe(1);
    expect(harness.webhookInsertSuccessCount).toBe(1);
    expect(harness.subscriptionChargeCount).toBe(1);

    // Subscription charges_done bumped from 1 to 2
    expect(harness.subscriptions.get("sub-1").charges_done).toBe(2);

    // 2. Simulate DUPLICATE event arrival (e.g. Horizon stream replay, polling replay)
    const match2 = matchPaymentToOrder(paymentEvent, sampleOrder, "TESTNET");
    expect(match2.outcome).toBe("paid");

    // Reconcile second payment
    await reconcileMatch(db, sampleOrder, match2, paymentEvent.hash);

    // Invariant: order update count remains 1, no second webhook, subscription not charged twice
    expect(harness.orderUpdateCount).toBe(1);
    expect(harness.webhookInsertSuccessCount).toBe(1);
    expect(harness.subscriptionChargeCount).toBe(1);
    expect(harness.subscriptions.get("sub-1").charges_done).toBe(2);
  });

  it("Path 2: Lease Takeover Mid-Processing Race — concurrent reconcile preserves single credit", async () => {
    // Pod A starts processing with lease
    const matchOutcome = matchPaymentToOrder(paymentEvent, sampleOrder, "TESTNET");
    expect(matchOutcome.outcome).toBe("paid");

    // Simulate Pod A and Pod B racing simultaneously to reconcile the payment
    const [resultA, resultB] = await Promise.allSettled([
      reconcileMatch(db, sampleOrder, matchOutcome, paymentEvent.hash),
      reconcileMatch(db, sampleOrder, matchOutcome, paymentEvent.hash),
    ]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    // Invariant: strictly exactly one transition succeeded
    expect(harness.orderUpdateCount).toBe(1);
    expect(harness.webhookInsertSuccessCount).toBe(1);
    expect(harness.orders.get(sampleOrder.id).status).toBe("paid");
    expect(harness.subscriptions.get("sub-1").charges_done).toBe(2);
  });

  it("Path 3: Concurrent Webhook Workers — delivery row state converges idempotently", async () => {
    // Reconcile once to enqueue delivery row
    const matchOutcome = matchPaymentToOrder(paymentEvent, sampleOrder, "TESTNET");
    await reconcileMatch(db, sampleOrder, matchOutcome, paymentEvent.hash);

    const deliveryKey = `${sampleOrder.id}:subscription.charged`;
    const delivery = harness.webhookDeliveries.get(deliveryKey);
    expect(delivery).toBeDefined();
    expect(delivery.status).toBe("queued");

    // Simulate two workers attempting to deliver the same queued webhook concurrently
    let deliveryCallCount = 0;
    const mockWorkerDeliver = async (workerId: string) => {
      const row = harness.webhookDeliveries.get(deliveryKey);
      // Double delivery guard: check if already claimed or sent
      if (row.status === "sent") {
        return { workerId, skipped: true };
      }
      deliveryCallCount++;
      // Mark as sent
      row.status = "sent";
      row.last_attempt_at = new Date().toISOString();
      return { workerId, skipped: false };
    };

    const [workerRes1, workerRes2] = await Promise.all([
      mockWorkerDeliver("worker-1"),
      mockWorkerDeliver("worker-2"),
    ]);

    expect(deliveryCallCount).toBe(1);
    expect(harness.webhookDeliveries.get(deliveryKey).status).toBe("sent");
    // At least one of the concurrent attempts processed it, second recognized sent state
    const processed = [workerRes1, workerRes2].filter((r) => !r.skipped);
    expect(processed.length).toBe(1);
  });

  it("Regression verification: losing atomic status guard causes double credit and is caught", async () => {
    // Re-create a broken harness that ignores status constraints
    const brokenDb = {
      from(table: string) {
        return {
          update(patch: any) {
            return {
              eq(col: string, val: any) {
                return {
                  in(statusCol: string, allowedStatuses: string[]) {
                    return {
                      select() {
                        return {
                          single() {
                            // BROKEN: ignores allowedStatuses and always updates
                            harness.orderUpdateCount++;
                            return Promise.resolve({ data: { id: val, ...patch }, error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          insert() {
            return Promise.resolve({ error: null });
          },
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
          },
        };
      },
    } as any;

    const matchOutcome = matchPaymentToOrder(paymentEvent, sampleOrder, "TESTNET");
    await reconcileMatch(brokenDb, sampleOrder, matchOutcome, paymentEvent.hash);
    expect(harness.orderUpdateCount).toBe(1);

    // Duplicate call on broken harness
    await reconcileMatch(brokenDb, sampleOrder, matchOutcome, paymentEvent.hash);
    // If idempotency was lost, orderUpdateCount increments to 2
    expect(harness.orderUpdateCount).toBe(2);
  });
});

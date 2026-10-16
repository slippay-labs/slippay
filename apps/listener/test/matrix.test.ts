import { describe, it, expect, vi, beforeEach } from "vitest";
import { processPaymentRecord } from "../src/horizon.js";

interface MockOrder {
  id: string;
  merchant_id: string;
  memo: string;
  status: string;
  usdc_amount: string;
  platform_fee_bp: number;
  external_ref?: string;
  brl_amount?: string;
  tx_hash?: string | null;
  paid_at?: string | null;
  subscription_id?: string | null;
  merchants: {
    stellar_address: string;
    platform_fee_bp: number;
  };
}

interface MockWebhookDelivery {
  order_id: string;
  type: string;
  payload: any;
}

function createMockDatabase() {
  const orders = new Map<string, MockOrder>();
  const subscriptions = new Map<string, any>();
  const webhookDeliveries: MockWebhookDelivery[] = [];
  const listenerState = new Map<string, any>();

  const db: any = {
    orders,
    subscriptions,
    webhookDeliveries,
    listenerState,
    from: (table: string) => {
      if (table === "orders") {
        return {
          select: (_fields?: string) => {
            let filterMemo: string | null = null;
            const builder = {
              eq: (col: string, val: any) => {
                if (col === "memo") filterMemo = val;
                return builder;
              },
              maybeSingle: async () => {
                for (const ord of orders.values()) {
                  if (filterMemo && ord.memo === filterMemo) {
                    return { data: { ...ord }, error: null };
                  }
                }
                return { data: null, error: null };
              },
            };
            return builder;
          },
          update: (patch: Partial<MockOrder>) => {
            let targetId: string | null = null;
            let allowedStatuses: string[] = [];

            const builder = {
              eq: (col: string, val: any) => {
                if (col === "id") targetId = val;
                return builder;
              },
              in: (col: string, vals: string[]) => {
                if (col === "status") allowedStatuses = vals;
                return builder;
              },
              select: () => builder,
              single: async () => {
                if (!targetId) return { data: null, error: { message: "missing_target_id" } };
                const ord = orders.get(targetId);
                if (!ord) return { data: null, error: { message: "not_found" } };
                if (allowedStatuses.length > 0 && !allowedStatuses.includes(ord.status)) {
                  // PostgREST returns no row if the WHERE/IN condition didn't match
                  return { data: null, error: { message: "no_pending_row" } };
                }

                // Apply update
                Object.assign(ord, patch);
                return { data: { ...ord }, error: null };
              },
            };
            return builder;
          },
        };
      }

      if (table === "subscriptions") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => {
                const sub = subscriptions.get(val);
                return { data: sub ? { ...sub } : null, error: null };
              },
            }),
          }),
          update: (patch: any) => ({
            eq: (_col: string, val: string) => {
              const sub = subscriptions.get(val);
              if (sub) Object.assign(sub, patch);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      if (table === "webhook_deliveries") {
        return {
          insert: async (delivery: MockWebhookDelivery) => {
            webhookDeliveries.push(delivery);
            return { error: null };
          },
        };
      }

      if (table === "listener_state") {
        return {
          upsert: async (row: any) => {
            listenerState.set(row.account_id, row);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return db;
}

const MERCHANT_ADDR = "G" + "M".repeat(55);
const MEMO_BYTES = Buffer.from("11".repeat(32), "hex");
const MEMO_HEX = MEMO_BYTES.toString("hex");
const MEMO_B64 = MEMO_BYTES.toString("base64");
const TESTNET_USDC = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function makeRawPaymentRecord(opts: {
  amount: string;
  txHash?: string;
  memoB64?: string;
  memoType?: string;
  to?: string;
  assetCode?: string;
  assetIssuer?: string;
}) {
  return {
    type: "payment",
    paging_token: "token-1",
    amount: opts.amount,
    asset_code: opts.assetCode ?? "USDC",
    asset_issuer: opts.assetIssuer ?? TESTNET_USDC,
    to: opts.to ?? MERCHANT_ADDR,
    transaction_hash: opts.txHash ?? "tx-hash-1",
    transaction: async () => ({
      memo_type: opts.memoType ?? "hash",
      memo: opts.memoB64 ?? MEMO_B64,
      successful: true,
    }),
  };
}

describe("Listener Manager & Reconciler · Paid / Underpaid / Expired Status Matrix", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
  });

  it("Matrix Case 1: Pending order matching exact payment transitions to paid and enqueues webhook", async () => {
    db.orders.set("ord-1", {
      id: "ord-1",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "pending",
      usdc_amount: "10.0000000",
      platform_fee_bp: 100,
      external_ref: "ref-1",
      brl_amount: "50.00",
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "10.0000000", txHash: "tx-exact" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-1")!;
    expect(order.status).toBe("paid");
    expect(order.tx_hash).toBe("tx-exact");
    expect(order.paid_at).toBeTruthy();

    expect(db.webhookDeliveries).toHaveLength(1);
    expect(db.webhookDeliveries[0].order_id).toBe("ord-1");
    expect(db.webhookDeliveries[0].type).toBe("order.paid");
    expect(db.webhookDeliveries[0].payload.data.tx_hash).toBe("tx-exact");
  });

  it("Matrix Case 2: Pending order with underpayment transitions to underpaid and enqueues order.underpaid", async () => {
    db.orders.set("ord-2", {
      id: "ord-2",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "pending",
      usdc_amount: "20.0000000",
      platform_fee_bp: 0,
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 0,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "5.0000000", txHash: "tx-under" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-2")!;
    expect(order.status).toBe("underpaid");
    expect(order.tx_hash).toBe("tx-under");

    expect(db.webhookDeliveries).toHaveLength(1);
    expect(db.webhookDeliveries[0].order_id).toBe("ord-2");
    expect(db.webhookDeliveries[0].type).toBe("order.underpaid");
    expect(db.webhookDeliveries[0].payload.data.expected).toBe("20.0000000");
    expect(db.webhookDeliveries[0].payload.data.received).toBe("5.0000000");
  });

  it("Matrix Case 3: Expired order receiving payment remains expired, asserts no double credit and no webhook", async () => {
    db.orders.set("ord-3", {
      id: "ord-3",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "expired",
      usdc_amount: "10.0000000",
      platform_fee_bp: 100,
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "10.0000000", txHash: "tx-late" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-3")!;
    expect(order.status).toBe("expired"); // status never mutated
    expect(order.tx_hash).toBeUndefined(); // no credit applied
    expect(order.paid_at).toBeUndefined();
    expect(db.webhookDeliveries).toHaveLength(0); // no webhook queued
  });

  it("Matrix Case 4: Cancelled order receiving payment remains cancelled, asserts no credit action", async () => {
    db.orders.set("ord-4", {
      id: "ord-4",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "cancelled",
      usdc_amount: "10.0000000",
      platform_fee_bp: 100,
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "10.0000000", txHash: "tx-cancelled" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-4")!;
    expect(order.status).toBe("cancelled");
    expect(order.tx_hash).toBeUndefined();
    expect(db.webhookDeliveries).toHaveLength(0);
  });

  it("Matrix Case 5: Already-paid order receiving duplicate payment is idempotent, asserts no second credit and no second webhook", async () => {
    db.orders.set("ord-5", {
      id: "ord-5",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "paid",
      usdc_amount: "10.0000000",
      platform_fee_bp: 100,
      tx_hash: "tx-first",
      paid_at: "2026-10-16T10:00:00Z",
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    // Simulate duplicate payment with a different on-chain transaction hash
    const payment = makeRawPaymentRecord({ amount: "10.0000000", txHash: "tx-duplicate" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-5")!;
    expect(order.status).toBe("paid");
    expect(order.tx_hash).toBe("tx-first"); // original tx hash retained
    expect(order.paid_at).toBe("2026-10-16T10:00:00Z");
    expect(db.webhookDeliveries).toHaveLength(0); // no duplicate webhook queued
  });

  it("Matrix Case 6: Overpayment (received > expected) transitions to paid and enqueues order.paid webhook", async () => {
    db.orders.set("ord-6", {
      id: "ord-6",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "pending",
      usdc_amount: "5.0000000",
      platform_fee_bp: 100,
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    // Received 10.0000000 USDC when 5.0000000 was expected
    const payment = makeRawPaymentRecord({ amount: "10.0000000", txHash: "tx-overpay" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-6")!;
    expect(order.status).toBe("paid");
    expect(order.tx_hash).toBe("tx-overpay");
    expect(db.webhookDeliveries).toHaveLength(1);
    expect(db.webhookDeliveries[0].type).toBe("order.paid");
  });

  it("Matrix Case 7: Underpaid order receiving top-up payment transitions to paid (audit-003 L3 forward transition)", async () => {
    db.orders.set("ord-7", {
      id: "ord-7",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "underpaid",
      usdc_amount: "15.0000000",
      platform_fee_bp: 100,
      tx_hash: "tx-partial",
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "15.0000000", txHash: "tx-topup" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-7")!;
    expect(order.status).toBe("paid");
    expect(order.tx_hash).toBe("tx-topup");
    expect(db.webhookDeliveries).toHaveLength(1);
    expect(db.webhookDeliveries[0].type).toBe("order.paid");
  });

  it("Matrix Case 8: Subscription order payment updates charges_done, expires subscription on reaching max_periods, and enqueues subscription.charged", async () => {
    db.subscriptions.set("sub-1", {
      id: "sub-1",
      charges_done: 2,
      max_periods: 3,
      status: "active",
    });

    db.orders.set("ord-8", {
      id: "ord-8",
      merchant_id: "merch-1",
      memo: MEMO_HEX,
      status: "pending",
      usdc_amount: "30.0000000",
      platform_fee_bp: 100,
      subscription_id: "sub-1",
      merchants: {
        stellar_address: MERCHANT_ADDR,
        platform_fee_bp: 100,
      },
    });

    const payment = makeRawPaymentRecord({ amount: "30.0000000", txHash: "tx-sub" });
    await processPaymentRecord(db, payment, "TESTNET", MERCHANT_ADDR);

    const order = db.orders.get("ord-8")!;
    expect(order.status).toBe("paid");

    const sub = db.subscriptions.get("sub-1")!;
    expect(sub.charges_done).toBe(3);
    expect(sub.status).toBe("expired"); // reached max_periods (3 >= 3)
    expect(sub.last_charge_at).toBeTruthy();

    expect(db.webhookDeliveries).toHaveLength(1);
    expect(db.webhookDeliveries[0].type).toBe("subscription.charged");
    expect(db.webhookDeliveries[0].payload.data.subscription_id).toBe("sub-1");
  });
});

import http from "node:http";
import {
  getManifest,
  handlePaymentCreate,
  handleSlippayWebhook,
  handleCancellation,
  handleSettlement,
  handleRefund,
  server,
  payments,
} from "../src/index.mjs";

let failures = 0;
const assert = (condition, description) => {
  if (condition) {
    console.log(`PASS  ${description}`);
  } else {
    console.error(`FAIL  ${description}`);
    failures++;
  }
};

console.log("--- VTEX Connector Unit Tests ---");

// 1. Manifest
{
  const manifest = getManifest();
  assert(Array.isArray(manifest.paymentMethods), "manifest has paymentMethods array");
  assert(manifest.paymentMethods[0]?.name === "SlipPay", "manifest declares SlipPay payment method");
  assert(manifest.paymentMethods[0]?.allowsSplit === "disabled", "manifest declares split as disabled");
}

// 2. Payment Creation - Success flow
{
  const testMap = new Map();
  let orderCreated = false;
  const mockCreateOrder = async ({ apiKey, value, reference }) => {
    orderCreated = true;
    return {
      order: { id: "ord_vtex_123", brl_amount: "199.90", usdc_amount: "35.50" },
      checkout_url: "https://app.slippay.cc/checkout/ord_vtex_123",
    };
  };

  const res = await handlePaymentCreate(
    {
      paymentId: "vtex-pay-001",
      value: 199.9,
      callbackUrl: "https://vtex.mock/callback",
      merchantSettings: { api_key: "sk_vtex_test" },
    },
    { paymentsMap: testMap, createOrderFn: mockCreateOrder }
  );

  assert(orderCreated, "createOrderFn was invoked");
  assert(res.status === 200, "payment creation returns 200");
  assert(res.body.status === "undefined", "status is undefined (pending redirect)");
  assert(res.body.tid === "ord_vtex_123", "tid matches order id");
  assert(res.body.paymentUrl === "https://app.slippay.cc/checkout/ord_vtex_123", "paymentUrl returned");
  assert(testMap.has("vtex-pay-001"), "payment is stored in paymentsMap");
}

// 3. Payment Creation - Idempotency
{
  const testMap = new Map();
  let calls = 0;
  const mockCreateOrder = async () => {
    calls++;
    return {
      order: { id: "ord_idem_1", brl_amount: "50.00", usdc_amount: "9.00" },
      checkout_url: "https://app.slippay.cc/checkout/ord_idem_1",
    };
  };

  const payload = {
    paymentId: "vtex-idem-001",
    value: 50.0,
    callbackUrl: "https://vtex.mock/callback",
    merchantSettings: { api_key: "sk_test" },
  };

  const res1 = await handlePaymentCreate(payload, { paymentsMap: testMap, createOrderFn: mockCreateOrder });
  const res2 = await handlePaymentCreate(payload, { paymentsMap: testMap, createOrderFn: mockCreateOrder });

  assert(calls === 1, "createOrderFn only called once for same paymentId");
  assert(res1.body.tid === res2.body.tid, "idempotent replay returns same tid");
  assert(res1.body.paymentUrl === res2.body.paymentUrl, "idempotent replay returns same paymentUrl");
}

// 4. Payment Creation - Missing API Key
{
  const testMap = new Map();
  const res = await handlePaymentCreate(
    { paymentId: "vtex-no-key", value: 10.0 },
    { paymentsMap: testMap, apiKeyFallback: "" }
  );
  assert(res.status === 200, "missing API key returns 200 status code");
  assert(res.body.status === "denied", "payment status is denied");
  assert(res.body.message.includes("missing SlipPay api_key"), "informative denial message");
}

// 5. Payment Creation - Backend Error Handling
{
  const testMap = new Map();
  const failingCreateOrder = async () => {
    throw new Error("upstream rate limit");
  };
  const res = await handlePaymentCreate(
    { paymentId: "vtex-err", value: 10.0, merchantSettings: { api_key: "sk_test" } },
    { paymentsMap: testMap, createOrderFn: failingCreateOrder }
  );
  assert(res.body.status === "denied", "upstream error results in status denied");
  assert(res.body.message.includes("upstream rate limit"), "error message preserved");
}

// 6. Webhook - Order Paid triggers VTEX callback
{
  const testMap = new Map();
  testMap.set("vtex-pay-hook", {
    slippayOrderId: "ord_hook_456",
    callbackUrl: "https://vtex.mock/notify",
    status: "undefined",
    checkoutUrl: "https://app.slippay.cc/checkout/ord_hook_456",
  });

  let callbackCalled = false;
  let callbackPayload = null;
  const mockFetch = async (url, opts) => {
    callbackCalled = true;
    callbackPayload = JSON.parse(opts.body);
    return { ok: true };
  };

  const hookRes = await handleSlippayWebhook(
    { event: "order.paid", order: { id: "ord_hook_456", status: "paid" } },
    { paymentsMap: testMap, fetchFn: mockFetch }
  );

  assert(hookRes.status === 200 && hookRes.body.received === true, "webhook returns 200 received: true");
  assert(callbackCalled, "callbackUrl was notified");
  assert(callbackPayload.paymentId === "vtex-pay-hook", "callback received correct paymentId");
  assert(callbackPayload.status === "approved", "callback payload marked approved");
  assert(testMap.get("vtex-pay-hook").status === "approved", "internal map updated to approved");
}

// 7. Cancellation, Settlement, Refund scaffolds
{
  const cancel = handleCancellation("pay-cancel-1");
  assert(cancel.code === "cancel-manually", "cancellation returns cancel-manually code");
  assert(typeof cancel.cancellationId === "string", "cancellation generates cancellationId");

  const settle = handleSettlement("pay-settle-1", 123.45);
  assert(settle.code === "settled-on-chain", "settlement returns settled-on-chain code");
  assert(settle.value === 123.45, "settlement preserves value");

  const refund = handleRefund("pay-refund-1", 50.0);
  assert(refund.code === "refund-manually", "refund returns refund-manually code");
  assert(refund.value === 50.0, "refund preserves value");
}

console.log("\n--- VTEX Connector HTTP Integration Tests ---");

const testPort = await new Promise((resolve) => {
  server.listen(0, () => {
    resolve(server.address().port);
  });
});

const baseUrl = `http://127.0.0.1:${testPort}`;

try {
  // HTTP: Manifest
  {
    const r = await fetch(`${baseUrl}/manifest`);
    const data = await r.json();
    assert(r.status === 200, "HTTP GET /manifest returns 200");
    assert(data.paymentMethods?.[0]?.name === "SlipPay", "HTTP GET /manifest returns SlipPay method");
  }

  // HTTP: Health
  {
    const r = await fetch(`${baseUrl}/health`);
    const data = await r.json();
    assert(r.status === 200 && data.ok === true, "HTTP GET /health returns ok: true");
  }

  // HTTP: Payments POST
  {
    const r = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId: "http-pay-1", value: 10 }),
    });
    const data = await r.json();
    assert(r.status === 200, "HTTP POST /payments returns 200");
    assert(data.paymentId === "http-pay-1", "HTTP POST /payments echoes paymentId");
  }

  // HTTP: Slippay Webhook POST
  {
    const r = await fetch(`${baseUrl}/slippay-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ping" }),
    });
    const data = await r.json();
    assert(r.status === 200 && data.received === true, "HTTP POST /slippay-webhook returns received: true");
  }

  // HTTP: Cancellations POST
  {
    const r = await fetch(`${baseUrl}/payments/p123/cancellations`, { method: "POST" });
    const data = await r.json();
    assert(r.status === 200 && data.code === "cancel-manually", "HTTP POST /cancellations returns code");
  }

  // HTTP: Settlements POST
  {
    const r = await fetch(`${baseUrl}/payments/p123/settlements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 99.9 }),
    });
    const data = await r.json();
    assert(r.status === 200 && data.value === 99.9, "HTTP POST /settlements returns value");
  }

  // HTTP: Refunds POST
  {
    const r = await fetch(`${baseUrl}/payments/p123/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 15.5 }),
    });
    const data = await r.json();
    assert(r.status === 200 && data.value === 15.5, "HTTP POST /refunds returns value");
  }

  // HTTP: 404 Route
  {
    const r = await fetch(`${baseUrl}/unknown-path`);
    assert(r.status === 404, "Unknown route returns 404");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? "\nALL VTEX TESTS PASSED" : `\n${failures} TEST FAILURES`);
process.exit(failures === 0 ? 0 : 1);

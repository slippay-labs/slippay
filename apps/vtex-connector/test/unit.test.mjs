import {
  formatBrlAmount,
  verifyVtexAuth,
  readBody,
  createSlippayOrder,
  createRequestHandler,
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

// Helper mock request and response
function createMockReqRes({ method, path, headers = {}, body = null }) {
  const req = {
    method,
    url: path,
    headers: { host: "localhost:4000", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) {
        yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      }
    },
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(content) {
      this.body = content ? JSON.parse(content) : null;
    },
  };

  return { req, res };
}

console.log("--- 1. VTEX Price & Amount Computation Tests ---");
{
  assert(formatBrlAmount(10) === "10.00", "integer amount formats to 2 decimals");
  assert(formatBrlAmount("29.9") === "29.90", "single decimal amount formats correctly");
  assert(formatBrlAmount("100.999") === "101.00", "multi-decimal amount rounds correctly");

  let threwZero = false;
  try { formatBrlAmount(0); } catch { threwZero = true; }
  assert(threwZero, "zero amount is rejected");

  let threwNegative = false;
  try { formatBrlAmount(-15.5); } catch { threwNegative = true; }
  assert(threwNegative, "negative amount is rejected");

  let threwNaN = false;
  try { formatBrlAmount("invalid_number"); } catch { threwNaN = true; }
  assert(threwNaN, "non-numeric string is rejected");
}

console.log("\n--- 2. VTEX PPP Header & Token Verification Tests ---");
{
  assert(verifyVtexAuth({}, "", ""), "passes when no credentials configured");
  assert(
    verifyVtexAuth(
      { "x-vtex-api-appkey": "key123", "x-vtex-api-apptoken": "tok456" },
      "key123",
      "tok456",
    ),
    "accepts matching lowercase headers",
  );
  assert(
    verifyVtexAuth(
      { "X-VTEX-API-AppKey": "key123", "X-VTEX-API-AppToken": "tok456" },
      "key123",
      "tok456",
    ),
    "accepts matching uppercase headers",
  );
  assert(
    !verifyVtexAuth(
      { "x-vtex-api-appkey": "wrong_key", "x-vtex-api-apptoken": "tok456" },
      "key123",
      "tok456",
    ),
    "rejects mismatching appKey",
  );
  assert(
    !verifyVtexAuth(
      { "x-vtex-api-appkey": "key123", "x-vtex-api-apptoken": "wrong_token" },
      "key123",
      "tok456",
    ),
    "rejects mismatching appToken",
  );
}

console.log("\n--- 3. Manifest Endpoint Tests ---");
{
  const handler = createRequestHandler();
  const { req, res } = createMockReqRes({ method: "GET", path: "/manifest" });
  await handler(req, res);
  assert(res.statusCode === 200, "manifest returns 200 OK");
  assert(res.body?.paymentMethods?.[0]?.name === "SlipPay", "manifest declares SlipPay payment method");
}

console.log("\n--- 4. Upstream SlipPay Order Creation & Error Mapping Tests ---");
{
  // Test 4.1 Missing API key
  const store = new Map();
  const handler = createRequestHandler({ paymentsStore: store, fallbackKey: "" });
  const { req, res } = createMockReqRes({
    method: "POST",
    path: "/payments",
    body: { paymentId: "pay_no_key", value: 100 },
  });
  await handler(req, res);
  assert(res.body?.status === "denied", "denies when API key missing in merchantSettings and fallback");
  assert(res.body?.message?.includes("missing SlipPay api_key"), "diagnostic message for missing API key");

  // Test 4.2 Upstream 201 Created
  const mockFetchSuccess = async (url, opts) => {
    return {
      status: 201,
      async json() {
        return {
          order: { id: "ord_vtex_99", brl_amount: "50.00", usdc_amount: "9.50" },
          checkout_url: "https://app.slippay.cc/checkout/ord_vtex_99",
        };
      },
    };
  };

  const handlerSuccess = createRequestHandler({
    paymentsStore: store,
    fallbackKey: "sk_test_123",
    fetchImpl: mockFetchSuccess,
  });

  const { req: req2, res: res2 } = createMockReqRes({
    method: "POST",
    path: "/payments",
    body: { paymentId: "pay_success_1", value: 50, callbackUrl: "https://vtex.mock/callback" },
  });
  await handlerSuccess(req2, res2);
  assert(res2.body?.status === "undefined", "returns status 'undefined' (pending async) for new order");
  assert(res2.body?.tid === "ord_vtex_99", "returns correct order ID as tid");
  assert(res2.body?.paymentUrl === "https://app.slippay.cc/checkout/ord_vtex_99", "returns hosted paymentUrl");

  // Test 4.3 Idempotency: same paymentId returns cached record without re-fetching
  let fetchCalledCount = 0;
  const mockFetchCount = async () => {
    fetchCalledCount++;
    return { status: 201, json: async () => ({ order: { id: "ord_idemp" }, checkout_url: "url" }) };
  };
  const handlerIdemp = createRequestHandler({
    paymentsStore: store,
    fallbackKey: "sk_test_123",
    fetchImpl: mockFetchCount,
  });
  const { req: reqIdemp, res: resIdemp } = createMockReqRes({
    method: "POST",
    path: "/payments",
    body: { paymentId: "pay_success_1" }, // existing in store
  });
  await handlerIdemp(reqIdemp, resIdemp);
  assert(fetchCalledCount === 0, "idempotent request does not invoke upstream fetch");
  assert(resIdemp.body?.tid === "ord_vtex_99", "idempotent response returns existing tid");

  // Test 4.4 Upstream error mapping (e.g. 500 or 400 from SlipPay)
  const mockFetchError = async () => {
    return {
      status: 400,
      async json() {
        return { error: "bad_request", message: "invalid BRL amount" };
      },
    };
  };
  const handlerErr = createRequestHandler({
    paymentsStore: store,
    fallbackKey: "sk_test_123",
    fetchImpl: mockFetchError,
  });
  const { req: reqErr, res: resErr } = createMockReqRes({
    method: "POST",
    path: "/payments",
    body: { paymentId: "pay_fail_1", value: 50 },
  });
  await handlerErr(reqErr, resErr);
  assert(resErr.body?.status === "denied", "upstream error maps to status: denied");
  assert(resErr.body?.message?.includes("slippay 400"), "diagnostic message includes upstream status code");
}

console.log("\n--- 5. Webhook & VTEX Callback Tests ---");
{
  const store = new Map();
  store.set("pay_webhook_test", {
    slippayOrderId: "ord_wh_123",
    callbackUrl: "https://vtex.mock/callback_endpoint",
    status: "undefined",
    checkoutUrl: "https://app.slippay.cc/checkout/ord_wh_123",
  });

  let callbackPayload = null;
  const mockFetchCallback = async (url, opts) => {
    if (url === "https://vtex.mock/callback_endpoint") {
      callbackPayload = JSON.parse(opts.body);
      return { status: 200, json: async () => ({ ok: true }) };
    }
    return { status: 404 };
  };

  const handler = createRequestHandler({ paymentsStore: store, fetchImpl: mockFetchCallback });
  const { req, res } = createMockReqRes({
    method: "POST",
    path: "/slippay-webhook",
    body: {
      event: "order.paid",
      order: { id: "ord_wh_123", status: "paid" },
    },
  });
  await handler(req, res);
  assert(res.body?.received === true, "webhook endpoint returns received: true");
  assert(store.get("pay_webhook_test").status === "approved", "payment status updated to approved");
  assert(callbackPayload?.status === "approved", "VTEX callback was called with status: approved");
  assert(callbackPayload?.paymentId === "pay_webhook_test", "VTEX callback received paymentId");
}

console.log("\n--- 6. Cancel, Settle & Refund Protocol Tests ---");
{
  const handler = createRequestHandler();

  // Cancel
  const { req: reqCancel, res: resCancel } = createMockReqRes({
    method: "POST",
    path: "/payments/pay_abc/cancellations",
  });
  await handler(reqCancel, resCancel);
  assert(resCancel.body?.code === "cancel-manually", "cancellation returns cancel-manually code");
  assert(resCancel.body?.paymentId === "pay_abc", "cancellation echoes paymentId");

  // Settle
  const { req: reqSettle, res: resSettle } = createMockReqRes({
    method: "POST",
    path: "/payments/pay_def/settlements",
    body: { value: 75.25 },
  });
  await handler(reqSettle, resSettle);
  assert(resSettle.body?.code === "settled-on-chain", "settlement returns settled-on-chain code");
  assert(resSettle.body?.value === 75.25, "settlement echoes transaction value");

  // Refund
  const { req: reqRefund, res: resRefund } = createMockReqRes({
    method: "POST",
    path: "/payments/pay_ghi/refunds",
    body: { value: 30.0 },
  });
  await handler(reqRefund, resRefund);
  assert(resRefund.body?.code === "refund-manually", "refund returns refund-manually code");
  assert(resRefund.body?.value === 30.0, "refund echoes transaction value");
}

console.log("\n--- 7. Health & 404 Route Tests ---");
{
  const handler = createRequestHandler({ slippayApiBase: "https://test.api.slippay.cc" });

  const { req: reqHealth, res: resHealth } = createMockReqRes({ method: "GET", path: "/health" });
  await handler(reqHealth, resHealth);
  assert(resHealth.body?.ok === true, "health returns ok: true");
  assert(resHealth.body?.slippay === "https://test.api.slippay.cc", "health reports slippay base URL");

  const { req: req404, res: res404 } = createMockReqRes({ method: "GET", path: "/unknown-route" });
  await handler(req404, res404);
  assert(res404.statusCode === 404, "unknown route returns 404");
}

console.log(failures === 0 ? "\nALL VTEX CONNECTOR UNIT TESTS PASSED" : `\n${failures} TEST FAILURES`);
process.exit(failures === 0 ? 0 : 1);

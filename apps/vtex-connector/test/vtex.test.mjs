import { Readable } from "node:stream";
import {
  payments,
  readBody,
  formatBrlAmount,
  createSlippayOrder,
  handleVtexRequest,
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

function makeReq(method, url, bodyObj) {
  const raw = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj)) : null;
  const req = Readable.from(raw ? [raw] : []);
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(payload = "") {
      this.body = payload;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
  return res;
}

console.log("--- VTEX Connector Unit Tests ---");

// 1. Price / total computation (formatBrlAmount)
{
  assert(formatBrlAmount(150) === "150.00", "formats integer BRL amount to 2 decimal places");
  assert(formatBrlAmount(99.9) === "99.90", "formats single-decimal BRL amount to 2 decimal places");
  assert(formatBrlAmount("42.556") === "42.56", "rounds string decimal BRL amount to 2 decimal places");

  let rejectedZero = false;
  try {
    formatBrlAmount(0);
  } catch {
    rejectedZero = true;
  }
  assert(rejectedZero, "rejects zero payment amount");

  let rejectedNegative = false;
  try {
    formatBrlAmount(-10);
  } catch {
    rejectedNegative = true;
  }
  assert(rejectedNegative, "rejects negative payment amount");

  let rejectedNaN = false;
  try {
    formatBrlAmount("not-a-number");
  } catch {
    rejectedNaN = true;
  }
  assert(rejectedNaN, "rejects non-numeric payment amount");
}

// 2. Request body parsing (readBody)
{
  const validStream = Readable.from([Buffer.from(JSON.stringify({ paymentId: "p-1", value: 25 }))]);
  const parsed = await readBody(validStream);
  assert(parsed.paymentId === "p-1" && parsed.value === 25, "parses valid JSON request body");

  const invalidStream = Readable.from([Buffer.from("{bad-json")]);
  const fallback = await readBody(invalidStream);
  assert(typeof fallback === "object" && Object.keys(fallback).length === 0, "returns empty object on malformed JSON");
}

// 3. Manifest & Health endpoints
{
  const req = makeReq("GET", "/manifest");
  const res = makeRes();
  await handleVtexRequest(req, res);
  assert(res.statusCode === 200 && res.json().paymentMethods?.[0]?.name === "SlipPay", "GET /manifest returns SlipPay payment method");

  const hReq = makeReq("GET", "/health");
  const hRes = makeRes();
  await handleVtexRequest(hReq, hRes);
  assert(hRes.statusCode === 200 && hRes.json().ok === true, "GET /health returns ok: true");
}

// 4. Token / API key verification (missing merchantSettings.api_key denies payment)
{
  payments.clear();
  const req = makeReq("POST", "/payments", { paymentId: "pay-no-key", value: 100 });
  const res = makeRes();
  await handleVtexRequest(req, res);
  const body = res.json();
  assert(
    res.statusCode === 200 && body.status === "denied" && body.message.includes("missing SlipPay api_key"),
    "POST /payments without merchantSettings.api_key returns status: denied",
  );
}

// 5. Payment creation, idempotency, and SlipPay order mapping
{
  payments.clear();
  const origFetch = globalThis.fetch;
  let capturedAuth = "";
  let capturedPayload = null;

  globalThis.fetch = async (_url, init) => {
    capturedAuth = init?.headers?.authorization ?? "";
    capturedPayload = JSON.parse(init?.body ?? "{}");
    return new Response(
      JSON.stringify({
        order: { id: "ord_vtex_1", brl_amount: capturedPayload.brl_amount, usdc_amount: "19.50" },
        checkout_url: "https://app.slippay.cc/checkout/ord_vtex_1",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const req = makeReq("POST", "/payments", {
      paymentId: "pay-101",
      value: 100.5,
      callbackUrl: "https://vtex.example.com/callback/pay-101",
      merchantSettings: { api_key: "sk_live_vtex_test" },
    });
    const res = makeRes();
    await handleVtexRequest(req, res);
    const body = res.json();

    assert(capturedAuth === "Bearer sk_live_vtex_test", "forwards Bearer token from merchantSettings.api_key");
    assert(capturedPayload.brl_amount === "100.50" && capturedPayload.reference === "pay-101", "maps value and reference to SlipPay order payload");
    assert(body.status === "undefined" && body.tid === "ord_vtex_1" && body.paymentUrl === "https://app.slippay.cc/checkout/ord_vtex_1", "returns VTEX pending (undefined) payment response with checkoutUrl");

    // Idempotent retry with same paymentId does not call fetch again
    globalThis.fetch = async () => {
      throw new Error("fetch should not be called on idempotent replay");
    };
    const dupReq = makeReq("POST", "/payments", {
      paymentId: "pay-101",
      value: 100.5,
      merchantSettings: { api_key: "sk_live_vtex_test" },
    });
    const dupRes = makeRes();
    await handleVtexRequest(dupReq, dupRes);
    const dupBody = dupRes.json();
    assert(dupBody.tid === "ord_vtex_1" && dupBody.paymentUrl === "https://app.slippay.cc/checkout/ord_vtex_1", "idempotent POST /payments returns cached order");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// 6. Upstream error mapping (non-201 from SlipPay API or invalid amount -> status: denied)
{
  payments.clear();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_merchant_key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  try {
    const req = makeReq("POST", "/payments", {
      paymentId: "pay-err-401",
      value: 50,
      merchantSettings: { api_key: "sk_bad" },
    });
    const res = makeRes();
    await handleVtexRequest(req, res);
    const body = res.json();
    assert(
      res.statusCode === 200 && body.status === "denied" && body.message.includes("slippay 401"),
      "maps upstream SlipPay 401 error to VTEX status: denied",
    );

    const badValReq = makeReq("POST", "/payments", {
      paymentId: "pay-err-val",
      value: -5,
      merchantSettings: { api_key: "sk_live_ok" },
    });
    const badValRes = makeRes();
    await handleVtexRequest(badValReq, badValRes);
    const badValBody = badValRes.json();
    assert(
      badValRes.statusCode === 200 && badValBody.status === "denied" && badValBody.message.includes("invalid payment value"),
      "maps invalid payment value to VTEX status: denied",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
}

// 7. Webhook callback forwarding (/slippay-webhook -> VTEX callbackUrl)
{
  payments.clear();
  payments.set("pay-202", {
    slippayOrderId: "ord_vtex_202",
    callbackUrl: "https://vtex.example.com/callback/pay-202",
    status: "undefined",
    checkoutUrl: "https://app.slippay.cc/checkout/ord_vtex_202",
  });

  const origFetch = globalThis.fetch;
  let callbackCalledWith = null;
  globalThis.fetch = async (url, init) => {
    callbackCalledWith = { url, body: JSON.parse(init?.body ?? "{}") };
    return new Response("{}", { status: 200 });
  };

  try {
    const req = makeReq("POST", "/slippay-webhook", {
      event: "order.paid",
      order: { id: "ord_vtex_202", status: "paid" },
    });
    const res = makeRes();
    await handleVtexRequest(req, res);

    assert(res.statusCode === 200 && res.json().received === true, "POST /slippay-webhook acknowledges event");
    assert(
      callbackCalledWith?.url === "https://vtex.example.com/callback/pay-202" &&
        callbackCalledWith?.body?.status === "approved" &&
        callbackCalledWith?.body?.paymentId === "pay-202",
      "notifies VTEX callbackUrl with approved status on order.paid",
    );
    assert(payments.get("pay-202").status === "approved", "updates internal payment state to approved");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// 8. Cancel / Settle / Refund scaffold routes
{
  const cancelRes = makeRes();
  await handleVtexRequest(makeReq("POST", "/payments/pay-303/cancellations", {}), cancelRes);
  assert(cancelRes.statusCode === 200 && cancelRes.json().code === "cancel-manually", "POST /payments/:id/cancellations returns cancel-manually");

  const settleRes = makeRes();
  await handleVtexRequest(makeReq("POST", "/payments/pay-303/settlements", { value: 80 }), settleRes);
  assert(settleRes.statusCode === 200 && settleRes.json().value === 80 && settleRes.json().code === "settled-on-chain", "POST /payments/:id/settlements returns settled-on-chain with value");

  const refundRes = makeRes();
  await handleVtexRequest(makeReq("POST", "/payments/pay-303/refunds", { value: 80 }), refundRes);
  assert(refundRes.statusCode === 200 && refundRes.json().value === 80 && refundRes.json().code === "refund-manually", "POST /payments/:id/refunds returns refund-manually with value");
}

console.log(failures === 0 ? "\nALL VTEX CONNECTOR TESTS PASSED" : `\n${failures} TEST FAILURES`);
process.exit(failures === 0 ? 0 : 1);

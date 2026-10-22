import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Covers price / total computation and the VTEX → SlipPay order mapping.
// A stub SlipPay backend is started in-process so the connector hits a
// real HTTP endpoint and the full request body is observed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "../src/index.mjs");

function startSlipPayStub() {
  const recorded = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    recorded.push({ url: req.url, headers: req.headers, body });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      order: { id: "ord_123", brl_amount: body.brl_amount, usdc_amount: "18.50" },
      checkout_url: "https://checkout.slippay.cc/ord_123",
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, recorded, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function startConnector(env) {
  const port = 5000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for connector")), 5000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("connector on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function stop(child) {
  if (child && !child.killed) child.kill();
}

test("createPayment forwards the total as a 2-decimal string", async () => {
  const stub = await startSlipPayStub();
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: stub.baseUrl, SLIPPAY_API_KEY: "" },
  );
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: "p-compute",
        value: 100.5,
        callbackUrl: "http://127.0.0.1/cb",
        merchantSettings: { api_key: "sk_test" },
      }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.tid, "ord_123");
    assert.strictEqual(body.paymentUrl, "https://checkout.slippay.cc/ord_123");

    assert.strictEqual(stub.recorded.length, 1);
    const call = stub.recorded[0];
    assert.strictEqual(call.url, "/api/v1/orders");
    assert.strictEqual(call.body.brl_amount, "100.50");
    assert.strictEqual(call.body.reference, "p-compute");
    assert.strictEqual(call.headers.authorization, "Bearer sk_test");
  } finally {
    stop(child);
    stub.server.close();
  }
});

test("createPayment is idempotent for the same paymentId", async () => {
  const stub = await startSlipPayStub();
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: stub.baseUrl, SLIPPAY_API_KEY: "" },
  );
  try {
    const payload = {
      paymentId: "p-idemp",
      value: 500,
      callbackUrl: "http://127.0.0.1/cb",
      merchantSettings: { api_key: "sk_test" },
    };
    const first = await (await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })).json();
    const second = await (await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })).json();
    assert.strictEqual(first.tid, second.tid);
    assert.strictEqual(first.paymentUrl, second.paymentUrl);
    // Only the first call should reach SlipPay.
    assert.strictEqual(stub.recorded.length, 1);
  } finally {
    stop(child);
    stub.server.close();
  }
});

test("settlement echoes the requested value", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments/p-1/settlements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 123.45 }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.paymentId, "p-1");
    assert.strictEqual(body.value, 123.45);
    assert.strictEqual(body.code, "settled-on-chain");
  } finally {
    stop(child);
  }
});

test("refund echoes the requested value", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments/p-2/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 7 }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.paymentId, "p-2");
    assert.strictEqual(body.value, 7);
    assert.strictEqual(body.code, "refund-manually");
  } finally {
    stop(child);
  }
});

test("cancellation returns a protocol-valid response", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments/p-3/cancellations`, { method: "POST" });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.paymentId, "p-3");
    assert.strictEqual(body.code, "cancel-manually");
    assert.strictEqual(typeof body.cancellationId, "string");
  } finally {
    stop(child);
  }
});

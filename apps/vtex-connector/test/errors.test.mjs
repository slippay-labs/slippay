import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Covers error mapping for failed upstream calls and the webhook → VTX 
// callback flow. Mirrors the Shopify connector test structure.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "../src/index.mjs");

function startSlipPayStub(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    await handler(req, res, body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function startConnector(env) {
  const port = 6000 + Math.floor(Math.random() * 1000);
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

test("failed upstream call maps to denied with the upstream message", async () => {
  const stub = await startSlipPayStub((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_key" }));
  });
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: stub.baseUrl, SLIPPAY_API_KEY: "" },
  );
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: "p-fail",
        value: 10,
        callbackUrl: "http://127.0.0.1/cb",
        merchantSettings: { api_key: "sk_bad" },
      }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.paymentId, "p-fail");
    assert.strictEqual(body.status, "denied");
    assert.match(body.message, /slippay 402/);
    assert.match(body.message, /invalid_key/);
  } finally {
    stop(child);
    stub.server.close();
  }
});

test("network failure to SlipPay maps to denied", async () => {
  // Point at a port that is not listening.
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: "http://127.0.0.1:1", SLIPPAY_API_KEY: "" },
  );
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: "p-net",
        value: 10,
        callbackUrl: "http://127.0.0.1/cb",
        merchantSettings: { api_key: "sk_test" },
      }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, "denied");
    assert.strictEqual(typeof body.message, "string");
  } finally {
    stop(child);
  }
});

test("slippay-webhook forwards approved status to the VTEX callbackUrl", async () => {
  const callbacks = [];
  const cbStub = await startSlipPayStub((req, res, body) => {
    callbacks.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const slipStub = await startSlipPayStub((req, res, body) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      order: { id: "ord_webhook", brl_amount: body.brl_amount, usdc_amount: "1.85" },
      checkout_url: "https://checkout.slippay.cc/ord_webhook",
    }));
  });
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: slipStub.baseUrl, SLIPPAY_API_KEY: "" },
  );
  try {
    const create = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: "p-wh",
        value: 10,
        callbackUrl: `${cbStub.baseUrl}/vtex-callback`,
        merchantSettings: { api_key: "sk_test" },
      }),
    });
    assert.strictEqual(create.status, 200);

    const webhook = await fetch(`${baseUrl}/slippay-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "order.paid", order: { id: "ord_webhook", status: "paid" } }),
    });
    const whBody = await webhook.json();
    assert.strictEqual(whBody.received, true);

    // Wait for the connector to dispatch the callback.
    for (let i = 0; i < 50 && callbacks.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(callbacks.length, 1);
    assert.strictEqual(callbacks[0].paymentId, "p-wh");
    assert.strictEqual(callbacks[0].status, "approved");
    assert.strictEqual(callbacks[0].tid, "ord_webhook");
  } finally {
    stop(child);
    cbStub.server.close();
    slipStub.server.close();
  }
});

test("slippay-webhook ignores unpaid events", async () => {
  const callbacks = [];
  const cbStub = await startSlipPayStub((req, res, body) => {
    callbacks.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const slipStub = await startSlipPayStub((req, res, body) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      order: { id: "ord_unpaid", brl_amount: body.brl_amount, usdc_amount: "1.85" },
      checkout_url: "https://checkout.slippay.cc/ord_unpaid",
    }));
  });
  const { child, baseUrl } = await startConnector(
    { SLIPPAY_API_BASE: slipStub.baseUrl, SLIPPAY_API_KEY: "" },
  );
  try {
    await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: "p-unpaid",
        value: 10,
        callbackUrl: `${cbStub.baseUrl}/vtex-callback`,
        merchantSettings: { api_key: "sk_test" },
      }),
    });

    const webhook = await fetch(`${baseUrl}/slippay-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "order.created", order: { id: "ord_unpaid", status: "pending" } }),
    });
    const whBody = await webhook.json();
    assert.strictEqual(whBody.received, true);

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(callbacks.length, 0);
  } finally {
    stop(child);
    cbStub.server.close();
    slipStub.server.close();
  }
});

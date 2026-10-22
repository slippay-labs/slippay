import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Mirrors the Shopify connector test structure: spawn the connector as a
// child process on an ephemeral port, then drive it over HTTP.
// This file covers request validation and the manifest contract.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "../src/index.mjs");

async function startConnector(env = {}) {
  const port = 4000 + Math.floor(Math.random() * 1000);
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

function stopConnector(child) {
  if (child && !child.killed) child.kill();
}

test("GET /manifest returns the SlipPay payment method", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/manifest`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.paymentMethods, [{ name: "SlipPay", allowsSplit: "disabled" }]);
  } finally {
    stopConnector(child);
  }
});

test("POST /payments without an api_key is denied", async () => {
  const { child, baseUrl } = await startConnector({ SLIPPAY_API_KEY: "" });
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId: "p-no-key", value: 100, callbackUrl: "http://127.0.0.1/cb" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.paymentId, "p-no-key");
    assert.strictEqual(body.status, "denied");
    assert.match(body.message, /missing SlipPay api_key/);
  } finally {
    stopConnector(child);
  }
});

test("POST /payments generates a paymentId when none is supplied", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 100 }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof body.paymentId, "string");
    assert.ok(randomUuidRegex().test(body.paymentId));
  } finally {
    stopConnector(child);
  }
});

test("POST /payments tolerates an empty body", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments`, { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "denied");
  } finally {
    stopConnector(child);
  }
});

test("POST /payments tolerates malformed JSON", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "denied");
  } finally {
    stopConnector(child);
  }
});

test("unknown routes return 404 with the path", async () => {
  const { child, baseUrl } = await startConnector();
  try {
    const res = await fetch(`${baseUrl}/not-a-route`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, "not_found");
    assert.strictEqual(body.path, "/not-a-route");
  } finally {
    stopConnector(child);
  }
});

function randomUuidRegex() {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
}

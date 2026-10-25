import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAttesterServer, resolveAttesterSecret } from "./server.mjs";
import { publicKeyHex } from "./oracle.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverScript = resolve(__dirname, "server.mjs");

console.log("testing slippay-attester HTTP service routes & guards (Issue #467)...");

// 1. Startup Guard Tests
{
  assert.throws(
    () => resolveAttesterSecret({}),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      assert.match(err.message, /not set/);
      return true;
    },
    "should fail when SLIPPAY_ATTESTER_SECRET is unset without opt-in",
  );

  const proc = spawnSync(process.execPath, [serverScript], {
    env: { ...process.env, SLIPPAY_ATTESTER_SECRET: "", SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "" },
    encoding: "utf8",
  });
  assert.equal(proc.status, 1, "CLI must exit with status 1 on unset secret");
  assert.match(proc.stderr, /FATAL: SLIPPAY_ATTESTER_SECRET not set/);
  console.log("  ✓ startup guard: refuses to start without secret or dev opt-in");
}

// 2. Start HTTP service on ephemeral port
const testEnv = {
  SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "1",
};
const { server, priv } = createAttesterServer({ env: testEnv });
await new Promise((res) => server.listen(0, res));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedPubkey = await publicKeyHex(priv);

try {
  // 3. GET /pubkey returns 200 and public key
  {
    const res = await fetch(`${baseUrl}/pubkey`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pubkey, expectedPubkey);
    console.log("  ✓ GET /pubkey: returns 200 with attester public key");
  }

  // 4. POST /register commits agent surface
  const agentId = "agent-http-test-01";
  const recipient = "GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K";
  {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        allowed_recipients: [recipient],
        allowed_tools: ["toolA", "toolB"],
        max_amount: "1000000",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.commitment);
    assert.equal(typeof body.commitment, "string");
    console.log("  ✓ POST /register: commits surface and returns commitment string");
  }

  // 5. POST /attest positive path (in surface) returns 200 with signature
  const subId = "a1".repeat(32);
  let validAttestation;
  {
    const res = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        subscription_id: subId,
        charges_done: 0,
        recipient,
        amount: "50000",
        tools_used: ["toolA"],
      }),
    });
    assert.equal(res.status, 200);
    validAttestation = await res.json();
    assert.equal(validAttestation.ok, true);
    assert.ok(validAttestation.signature);
    assert.ok(validAttestation.not_after);
    console.log("  ✓ POST /attest (in-surface): returns 200 with signature");
  }

  // 6. POST /attest negative path (out-of-surface) returns 403, NOT 200
  {
    // Deviation 1: Unknown recipient
    const resUnkRecip = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        subscription_id: subId,
        charges_done: 1,
        recipient: "GBBM6W2V7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K", // not in allowed_recipients
        amount: "50000",
      }),
    });
    assert.equal(resUnkRecip.status, 403, "refused attestation must return 403, not 200");
    const bodyUnkRecip = await resUnkRecip.json();
    assert.equal(bodyUnkRecip.ok, false);
    assert.match(bodyUnkRecip.reason, /outside the committed surface/);

    // Deviation 2: Exceeds max_amount cap
    const resOverCap = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        subscription_id: subId,
        charges_done: 1,
        recipient,
        amount: "99999999999", // exceeds 1000000
      }),
    });
    assert.equal(resOverCap.status, 403, "over-cap attestation must return 403");
    const bodyOverCap = await resOverCap.json();
    assert.equal(bodyOverCap.ok, false);
    assert.match(bodyOverCap.reason, /exceeds the committed cap/);
    console.log("  ✓ POST /attest (refused): returns 403 (fail-closed) rather than 200");
  }

  // 7. POST /verify verifies valid and invalid signatures
  {
    const resValid = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription_id: subId,
        charges_done: 0,
        not_after: validAttestation.not_after,
        signature: validAttestation.signature,
        pubkey: expectedPubkey,
      }),
    });
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.valid, true);

    // Tampered charges_done
    const resTampered = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription_id: subId,
        charges_done: 99,
        not_after: validAttestation.not_after,
        signature: validAttestation.signature,
        pubkey: expectedPubkey,
      }),
    });
    assert.equal(resTampered.status, 200);
    const bodyTampered = await resTampered.json();
    assert.equal(bodyTampered.valid, false);
    console.log("  ✓ POST /verify: accurately validates genuine and tampered signatures");
  }

  // 8. 404 fallback on unknown routes
  {
    const res404Get = await fetch(`${baseUrl}/non-existent-route`);
    assert.equal(res404Get.status, 404);
    const body404 = await res404Get.json();
    assert.equal(body404.error, "not found");

    const res404Post = await fetch(`${baseUrl}/v1/unknown`, { method: "POST" });
    assert.equal(res404Post.status, 404);
    console.log("  ✓ unknown route returns 404 with not found error");
  }

  // 9. Malformed JSON body produces defined 400 error instead of silent {}
  {
    const resMalformed = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is invalid json payload",
    });
    assert.equal(resMalformed.status, 400, "malformed JSON body must return 400");
    const bodyErr = await resMalformed.json();
    assert.match(bodyErr.error, /malformed_json/, "error message must indicate malformed_json");
    console.log("  ✓ malformed JSON body returns 400 with malformed_json error");
  }
} finally {
  server.close();
}

console.log("\n=== all Issue #467 oracle HTTP service tests passed ===");

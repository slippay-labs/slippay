import assert from "node:assert/strict";
import { clearSurfaces } from "./oracle.mjs";
import { createAttesterServer } from "./server.mjs";

console.log("testing slippay-attester endpoint authentication and CORS guards (Issue #466)...");

// Clear any state from previous tests
clearSurfaces();

const testEnv = {
  SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "1",
  SLIPPAY_ATTESTER_ALLOWED_ORIGINS: "https://app.slippay.com,https://api.slippay.com",
};

const { server } = createAttesterServer({ env: testEnv });

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // 1. Unauthenticated POST /register is rejected with 401
  {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        allowed_recipients: ["GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K"],
        max_amount: "1000000",
      }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthenticated");
    assert.equal(body.reason, "authentication_required_for_register");
    console.log("  ✓ unauthenticated POST /register is rejected with 401");
  }

  // 2. Unauthenticated POST /attest is rejected with 401
  {
    const res = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        subscription_id: "00".repeat(32),
        charges_done: 0,
        recipient: "GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K",
        amount: "500",
      }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthenticated");
    assert.equal(body.reason, "authentication_required_for_attest");
    console.log("  ✓ unauthenticated POST /attest is rejected with 401");
  }

  // 3. Authenticated POST /register succeeds and binds agent to Principal A
  {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-principal-a",
      },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        allowed_recipients: ["GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K"],
        max_amount: "1000000",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.commitment);
    assert.equal(typeof body.commitment, "string");
    console.log("  ✓ authenticated POST /register succeeds and binds owner principal");
  }

  // 4. Same Principal A can update / re-register agent-alpha
  {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-principal-a",
      },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        allowed_recipients: [
          "GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K",
          "GBBM6W2V7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K",
        ],
        max_amount: "2000000",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.commitment);
    console.log("  ✓ same principal can update existing agent registration");
  }

  // 5. A different Principal B cannot hijack or re-register agent-alpha (403 Forbidden)
  {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-principal-b",
      },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        allowed_recipients: ["GEVIL7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K"],
        max_amount: "99999999",
      }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "forbidden");
    assert.match(body.reason, /owned by another principal/);
    console.log("  ✓ different principal cannot re-register agent (403 forbidden)");
  }

  // 6. Different Principal B cannot request attestation for agent-alpha (403 Forbidden)
  {
    const res = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-principal-b",
      },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        subscription_id: "01".repeat(32),
        charges_done: 0,
        recipient: "GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K",
        amount: "500",
      }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.reason, /owned by another principal/);
    console.log("  ✓ different principal cannot request attestation for agent (403 forbidden)");
  }

  // 7. Owner Principal A can request attestation for agent-alpha successfully
  {
    const res = await fetch(`${baseUrl}/attest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-principal-a",
      },
      body: JSON.stringify({
        agent_id: "agent-alpha",
        subscription_id: "01".repeat(32),
        charges_done: 0,
        recipient: "GAFK7XFZEV7Y4W6Q5GZ7XU5O8V2E3F4G5H6I7J8K",
        amount: "500",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.signature);
    assert.ok(body.not_after);
    console.log("  ✓ owner principal can request attestation successfully");
  }

  // 8. CORS is restricted to named origins
  {
    // Allowed origin
    const resAllowed = await fetch(`${baseUrl}/pubkey`, {
      headers: { Origin: "https://app.slippay.com" },
    });
    assert.equal(resAllowed.status, 200);
    assert.equal(
      resAllowed.headers.get("access-control-allow-origin"),
      "https://app.slippay.com",
    );

    // Disallowed / unauthorized origin
    const resDisallowed = await fetch(`${baseUrl}/pubkey`, {
      headers: { Origin: "https://attacker.example.com" },
    });
    assert.equal(resDisallowed.status, 200);
    assert.equal(resDisallowed.headers.get("access-control-allow-origin"), null);

    // Preflight OPTIONS for allowed origin
    const preflight = await fetch(`${baseUrl}/register`, {
      method: "OPTIONS",
      headers: { Origin: "https://api.slippay.com" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://api.slippay.com",
    );

    console.log("  ✓ CORS is strictly restricted to named origins (wildcard disallowed)");
  }
} finally {
  server.close();
}

console.log("\n=== all Issue #466 endpoint authentication & CORS tests passed ===");

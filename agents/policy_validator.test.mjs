// Policy Validator Test Suite — Issue #347
//
// Validates that descriptive .ssl policy documents and runtime execution code agree.
// "Two sources of truth for a policy is a divergence waiting to happen.
// Decide which one is authoritative and test the other against it."
//
// Precedence: Code is authoritative ("the teeth").
// SSL files are the human- and auditor-readable auditable specification.
// This test asserts that the documented assertions, reasons, tools, and limits
// match the code's implementation with zero divergence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extracts error reason strings declared in .ssl @assertions sections.
 * Matches patterns like reason="foo", reason ∈ {foo, bar}, or reason=="foo".
 */
function extractSslReasons(sslContent) {
  const reasons = new Set();
  
  // Match reason="abc" or reason=='abc'
  const stringMatches = sslContent.matchAll(/reason\s*={1,2}\s*["']([^"']+)["']/g);
  for (const m of stringMatches) {
    reasons.add(m[1]);
  }

  // Match reason ∈ {a, b, c} or reason in {a, b}
  const setMatches = sslContent.matchAll(/reason\s*(?:∈|in)\s*\{([^}]+)\}/g);
  for (const m of setMatches) {
    const items = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    for (const item of items) {
      if (item) reasons.add(item);
    }
  }

  return Array.from(reasons).sort();
}

/**
 * Extracts reason strings returned in JavaScript source code.
 * Matches return statements or objects with reason: "xyz".
 */
function extractCodeReasons(jsContent) {
  const reasons = new Set();
  const matches = jsContent.matchAll(/reason:\s*["']([^"']+)["']/g);
  for (const m of matches) {
    if (m[1] !== "ok") {
      reasons.add(m[1]);
    }
  }
  return Array.from(reasons).sort();
}

/**
 * Extracts bound tools list from @bind section in .ssl file.
 */
function extractSslBoundTools(sslContent) {
  const match = sslContent.match(/bind\s+\w+\s*->\s*\[([^\]]+)\]/);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
}

test("Policy Validator: Billing Agent (.ssl vs bill.mjs)", (t) => {
  const sslPath = resolve(__dirname, "billing/billing.ssl");
  const codePath = resolve(__dirname, "billing/bill.mjs");
  const sslContent = readFileSync(sslPath, "utf-8");
  const codeContent = readFileSync(codePath, "utf-8");

  const sslReasons = extractSslReasons(sslContent);
  const codeReasons = extractCodeReasons(codeContent);

  // 1. Assert exact error reason congruence
  assert.deepEqual(
    codeReasons,
    sslReasons,
    `Billing code reasons (${codeReasons.join(",")}) must match .ssl reasons (${sslReasons.join(",")})`
  );
  assert.ok(sslReasons.includes("not_active"));
  assert.ok(sslReasons.includes("expired"));
  assert.ok(sslReasons.includes("max_periods_reached"));
  assert.ok(sslReasons.includes("period_not_elapsed"));

  // 2. Assert bound capabilities
  const boundTools = extractSslBoundTools(sslContent);
  assert.deepEqual(boundTools, ["propose_charge", "read_subscription"]);

  // 3. Assert fidelity: charge_intent fields in code match documented scope
  assert.match(sslContent, /WRITE\s*\$\s*charge_intent\s*\{\s*mandateId,\s*amount,\s*recipient,\s*token,\s*periodIndex,\s*nonce\s*\}/);
  assert.match(codeContent, /mandateId:\s*sub\.mandateId/);
  assert.match(codeContent, /amount:\s*sub\.consentedAmount/);
  assert.match(codeContent, /recipient:\s*sub\.consentedRecipient/);
  assert.match(codeContent, /token:\s*sub\.token/);
  assert.match(codeContent, /periodIndex:\s*sub\.chargesDone\s*\+\s*1/);
});

test("Policy Validator: Authority Agent (.ssl vs authorize.mjs)", (t) => {
  const sslPath = resolve(__dirname, "authority/authority.ssl");
  const codePath = resolve(__dirname, "authority/authorize.mjs");
  const sslContent = readFileSync(sslPath, "utf-8");
  const codeContent = readFileSync(codePath, "utf-8");

  const sslReasons = extractSslReasons(sslContent);
  const codeReasons = extractCodeReasons(codeContent);

  // 1. Assert exact error reason congruence
  assert.deepEqual(
    codeReasons,
    sslReasons,
    `Authority code reasons (${codeReasons.join(",")}) must match .ssl reasons (${sslReasons.join(",")})`
  );
  assert.deepEqual(codeReasons, ["bad_signature", "replay", "term_drift"]);

  // 2. Assert zero money-moving capability
  assert.match(sslContent, /HARD_DENY\s*\$\s*submit_transaction\s*∨\s*settle\s*∨\s*charge/);
  assert.doesNotMatch(codeContent, /transfer_funds|submit_transaction/);
});

test("Policy Validator: Settlement Agent (.ssl vs settle.mjs)", (t) => {
  const sslPath = resolve(__dirname, "settlement/settlement.ssl");
  const codePath = resolve(__dirname, "settlement/settle.mjs");
  const sslContent = readFileSync(sslPath, "utf-8");
  const codeContent = readFileSync(codePath, "utf-8");

  const sslReasons = extractSslReasons(sslContent);
  const codeReasons = extractCodeReasons(codeContent);

  // 1. Assert exact error reason congruence
  assert.deepEqual(
    codeReasons,
    sslReasons,
    `Settlement code reasons (${codeReasons.join(",")}) must match .ssl reasons (${sslReasons.join(",")})`
  );
  assert.deepEqual(
    codeReasons,
    ["amount_short", "asset_mismatch", "memo_mismatch", "recipient_drift", "replay"]
  );

  // 2. Assert recipient drift protection
  assert.match(sslContent, /p\.destination\s*==\s*O\.consentedRecipient\s*∨\s*reason="recipient_drift"/);
  assert.match(codeContent, /payment\.destination\s*!==\s*order\.consentedRecipient/);

  // 3. Assert bound capabilities
  const boundTools = extractSslBoundTools(sslContent);
  assert.deepEqual(boundTools, ["propose_settlement", "read_balance", "record_receipt"]);
});

test("Policy Validator: AntiAbuse Agent (.ssl vs antiabuse.mjs)", (t) => {
  const sslPath = resolve(__dirname, "antiabuse/antiabuse.ssl");
  const codePath = resolve(__dirname, "antiabuse/antiabuse.mjs");
  const sslContent = readFileSync(sslPath, "utf-8");
  const codeContent = readFileSync(codePath, "utf-8");

  const sslReasons = extractSslReasons(sslContent);
  const codeReasons = extractCodeReasons(codeContent);

  // 1. Assert exact error reason congruence
  assert.deepEqual(
    codeReasons,
    sslReasons,
    `AntiAbuse code reasons (${codeReasons.join(",")}) must match .ssl reasons (${sslReasons.join(",")})`
  );
  assert.deepEqual(codeReasons, ["conservation", "noninterference", "velocity"]);

  // 2. Assert HALT semantics (compiles to empty toolset)
  assert.match(sslContent, /toolset\(agent\)\s*:=\s*∅/);
  assert.match(codeContent, /compileToolset\(\s*\[\]\s*,\s*registry\s*\)/);
});

test("Policy Validator: Pulse Payment Intelligence Agent (.ssl vs pulse.py)", (t) => {
  const sslPath = resolve(__dirname, "pulse/pulse.ssl");
  const pyPath = resolve(__dirname, "pulse/pulse.py");
  const sslContent = readFileSync(sslPath, "utf-8");
  const pyContent = readFileSync(pyPath, "utf-8");

  // 1. Assert scan intervals from SSL match Python constants
  assert.match(sslContent, /scan_interval\s*:=\s*300s/); // webhook
  assert.match(sslContent, /scan_interval\s*:=\s*120s/); // horizon
  assert.match(pyContent, /WEBHOOK_INTERVAL\s*=\s*300/);
  assert.match(pyContent, /HORIZON_INTERVAL\s*=\s*120/);

  // 2. Assert latency threshold matches
  assert.match(sslContent, /latency_threshold\s*:=\s*3000ms/);
  assert.match(pyContent, /HORIZON_LATENCY_THRESHOLD_MS\s*=\s*3000/);

  // 3. Assert daily report schedule
  assert.match(sslContent, /schedule\s*:=\s*09:00\s*BRT/);
  assert.match(pyContent, /DAILY_REPORT_HOUR_BRT\s*=\s*9/);

  // 4. Assert Horizon network targets
  assert.match(sslContent, /"https:\/\/horizon\.stellar\.org"/);
  assert.match(sslContent, /"https:\/\/horizon-testnet\.stellar\.org"/);
  assert.match(pyContent, /"mainnet":\s*"https:\/\/horizon\.stellar\.org"/);
  assert.match(pyContent, /"testnet":\s*"https:\/\/horizon-testnet\.stellar\.org"/);
});

test("Policy Validator: Perena & Concierge Non-Transactional Boundaries", (t) => {
  const perenaSsl = readFileSync(resolve(__dirname, "perena/perena_ops.ssl"), "utf-8");
  const conciergeSsl = readFileSync(resolve(__dirname, "concierge/concierge.ssl"), "utf-8");

  // Perena must never submit transactions or touch smart contract state
  assert.match(perenaSsl, /HARD_DENY\s*\$\s*∀submit_transaction\(Solana\s*∨\s*EVM\)/);
  assert.match(perenaSsl, /HARD_DENY\s*\$\s*∀write_to\(smart_contract\)/);

  // Concierge (Eve) must never access internal financial tables or mention keys
  assert.match(conciergeSsl, /HARD_DENY\s*\$\s*∀access\(merchants\s*∨\s*orders\s*∨\s*subscriptions\s*∨\s*webhook_deliveries\)/);
  assert.match(conciergeSsl, /HARD_DENY\s*\$\s*∀mention\(internal_state\s*OR\s*live_metrics\s*OR\s*API\s*keys\)/);
  assert.match(conciergeSsl, /ALLOW_EXTERNAL_API\s*\$\s*\{Exa_web_search\}\s*ONLY/);
});

test("Policy Validator: Drift Protection Invariant (Negative Assertion)", (t) => {
  // Verifies that the validator detects drift if a reason is tampered with
  const mockSsl = `@assertions $ ∀x : x == true ∨ reason="original_reason" $`;
  const mockCode = `if (!x) return { ok: false, reason: "tampered_reason" };`;

  const sslReasons = extractSslReasons(mockSsl);
  const codeReasons = extractCodeReasons(mockCode);

  assert.throws(() => {
    assert.deepEqual(codeReasons, sslReasons);
  }, /AssertionError/);
});

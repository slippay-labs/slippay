// BillingAgent enforcement — proposes charge intents; never moves money. Its
// teeth: it cannot bill early, past max_periods, when expired, or when inactive,
// and it is bound away from any settlement capability. The intent it emits is
// exactly what AuthorityAgent.authorizeIntent consumes (the chain composes).
//
// Run: node --test agents/billing/bill.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { proposeCharge } from "./bill.mjs";
import { parseBind, compileToolset } from "../axl/bind.mjs";

function sub(over = {}) {
  return {
    id: "sub_1", status: "active",
    periodSeconds: 2_592_000, maxPeriods: 12, chargesDone: 1,
    lastChargeAt: 1000, expiresAt: 0,
    consentedAmount: "29000000", consentedRecipient: "GMERCH", token: "USDC", mandateId: "m_1",
    ...over,
  };
}

test("proposes a charge when active and the period has elapsed", () => {
  const r = proposeCharge(sub(), 1000 + 2_592_000, "n_1");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.intent.amount, "29000000");
  assert.equal(r.intent.recipient, "GMERCH");
  assert.equal(r.intent.periodIndex, 2);
  assert.equal(r.intent.nonce, "n_1");
});

test("refuses to bill before the period has elapsed (no early billing)", () => {
  const r = proposeCharge(sub(), 1000 + 100, "n_1");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "period_not_elapsed");
});

test("refuses a non-active subscription", () => {
  const r = proposeCharge(sub({ status: "paused" }), 9e9, "n_1");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_active");
});

test("refuses once max_periods is reached", () => {
  const r = proposeCharge(sub({ chargesDone: 12, maxPeriods: 12 }), 9e9, "n_1");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "max_periods_reached");
});

test("refuses an expired subscription", () => {
  const r = proposeCharge(sub({ expiresAt: 2000 }), 9e9, "n_1");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("first charge (lastChargeAt 0) is allowed immediately", () => {
  const r = proposeCharge(sub({ lastChargeAt: 0, chargesDone: 0 }), 5000, "n_1");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.intent.periodIndex, 1);
});

test("the agent is bound to propose only — it cannot move money", () => {
  const REGISTRY = {
    read_subscription: { name: "read_subscription", description: "", input_schema: {} },
    propose_charge: { name: "propose_charge", description: "", input_schema: {} },
    transfer_funds: { name: "transfer_funds", description: "", input_schema: {} },
  };
  const { capabilities } = parseBind("bind Billing -> [read_subscription, propose_charge]");
  const tools = compileToolset(capabilities, REGISTRY);
  assert.equal(tools.find((t) => t.name === "transfer_funds"), undefined);
});

test("boundary: expiresAt boundary on both sides (T-1 ok, T expired, T+1 expired)", () => {
  const expiry = 5000;
  const s = sub({ lastChargeAt: 0, expiresAt: expiry });

  // 1 unit before expiry: permitted
  const before = proposeCharge(s, expiry - 1, "n_1");
  assert.equal(before.ok, true);

  // exactly at expiry: rejected
  const at = proposeCharge(s, expiry, "n_2");
  assert.equal(at.ok, false);
  assert.equal(at.reason, "expired");

  // 1 unit after expiry: rejected
  const after = proposeCharge(s, expiry + 1, "n_3");
  assert.equal(after.ok, false);
  assert.equal(after.reason, "expired");
});

test("boundary: maxPeriods boundary on both sides (M-1 ok, M rejected, M+1 rejected)", () => {
  const max = 10;
  // M-1 (9 of 10): permitted
  const before = proposeCharge(sub({ maxPeriods: max, chargesDone: max - 1, lastChargeAt: 0 }), 1000, "n_1");
  assert.equal(before.ok, true);
  assert.equal(before.intent.periodIndex, 10);

  // exactly at M (10 of 10): rejected
  const at = proposeCharge(sub({ maxPeriods: max, chargesDone: max, lastChargeAt: 0 }), 1000, "n_2");
  assert.equal(at.ok, false);
  assert.equal(at.reason, "max_periods_reached");

  // M+1 (11 of 10): rejected
  const after = proposeCharge(sub({ maxPeriods: max, chargesDone: max + 1, lastChargeAt: 0 }), 1000, "n_3");
  assert.equal(after.ok, false);
  assert.equal(after.reason, "max_periods_reached");
});

test("boundary: periodSeconds elapsed boundary (P-1 rejected, P ok, P+1 ok)", () => {
  const last = 1000;
  const period = 500;
  const s = sub({ lastChargeAt: last, periodSeconds: period });

  // 1 unit before full period: rejected
  const before = proposeCharge(s, last + period - 1, "n_1");
  assert.equal(before.ok, false);
  assert.equal(before.reason, "period_not_elapsed");

  // exactly at period: permitted
  const at = proposeCharge(s, last + period, "n_2");
  assert.equal(at.ok, true);

  // 1 unit past period: permitted
  const after = proposeCharge(s, last + period + 1, "n_3");
  assert.equal(after.ok, true);
});

test("fail-closed: missing or malformed status refuses charge", () => {
  for (const badStatus of [null, undefined, "", "canceled", "unknown", 123]) {
    const r = proposeCharge(sub({ status: badStatus }), 9e9, "n_1");
    assert.equal(r.ok, false, `Expected bad status ${badStatus} to fail-closed`);
    assert.equal(r.reason, "not_active");
  }
});

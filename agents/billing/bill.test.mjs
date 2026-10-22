// BillingAgent enforcement — proposes charge intents; never moves money. Its teeth: it cannot bill early, past max_periods, when expired, or when inactive, and it is bound away from any settlement capability. The intent it emits is exactly what AuthorityAgent.authorizeIntent consumes (the chain composes).
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

test("bills exactly at the period boundary (one second before is refused)", () => {
  const due = 1000 + 2_592_000;
  const before = proposeCharge(sub(), due - 1, "n_1");
  assert.equal(before.ok, false);
  assert.equal(before.reason, "period_not_elapsed");
  const at = proposeCharge(sub(), due, "n_1");
  assert.equal(at.ok, true, at.reason);
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

test("allows the last permitted period (one below max_periods) but not one past", () => {
  const last = proposeCharge(sub({ chargesDone: 11, maxPeriods: 12 }), 9e9, "n_1");
  assert.equal(last.ok, true, last.reason);
  assert.equal(last.intent.periodIndex, 12);
  const past = proposeCharge(sub({ chargesDone: 13, maxPeriods: 12 }), 9e9, "n_1");
  assert.equal(past.ok, false);
  assert.equal(past.reason, "max_periods_reached");
});

test("refuses an expired subscription", () => {
  const r = proposeCharge(sub({ expiresAt: 2000 }), 9e9, "n_1");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("expiry boundary: allowed one second before expiry, refused exactly at expiry", () => {
  const expiresAt = 5000;
  const before = proposeCharge(sub({ expiresAt }), expiresAt - 1, "n_1");
  assert.equal(before.ok, true, before.reason);
  const at = proposeCharge(sub({ expiresAt }), expiresAt, "n_1");
  assert.equal(at.ok, false);
  assert.equal(at.reason, "expired");
});

test("first charge (lastChargeAt 0) is allowed immediately", () => {
  const r = proposeCharge(sub({ lastChargeAt: 0, chargesDone: 0 }), 5000, "n_1");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.intent.periodIndex, 1);
});

test("fails closed on malformed or missing input fields", () => {
  for (const bad of [null, undefined, {}, { status: "active" }]) {
    const r = proposeCharge(bad, 9e9, "n_1");
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test("fails closed on a missing nonce", () => {
  const r = proposeCharge(sub(), 9e9, undefined);
  assert.equal(r.ok, false);
});

test("fails closed on a non-numeric clock", () => {
  const r = proposeCharge(sub(), "not-a-number", "n_1");
  assert.equal(r.ok, false);
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

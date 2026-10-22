import test from "node:test";
import assert from "node:assert/strict";
import { computeNextChargeState, isTerminalError } from "./autocharge-scheduler.mjs";

test("computeNextChargeState - advances next_charge_at by period_seconds and increments charges_done", () => {
  const baseTime = 1700000000000; // fixed timestamp
  const sub = {
    id: "sub_1",
    charges_done: 2,
    max_periods: 5,
    period_seconds: 30 * 86400, // 30 days
  };

  const patch = computeNextChargeState(sub, baseTime);

  assert.equal(patch.charges_done, 3);
  assert.equal(patch.last_charge_at, new Date(baseTime).toISOString());
  assert.equal(patch.next_charge_at, new Date(baseTime + 30 * 86400 * 1000).toISOString());
  assert.equal(patch.status, undefined); // not reached max_periods
});

test("computeNextChargeState - marks subscription as expired when max_periods is reached", () => {
  const baseTime = 1700000000000;
  const sub = {
    id: "sub_2",
    charges_done: 4,
    max_periods: 5,
    period_seconds: 7 * 86400, // 7 days
  };

  const patch = computeNextChargeState(sub, baseTime);

  assert.equal(patch.charges_done, 5);
  assert.equal(patch.status, "expired");
  assert.equal(patch.next_charge_at, new Date(baseTime + 7 * 86400 * 1000).toISOString());
});

test("computeNextChargeState - handles missing charges_done and defaults period to 30 days", () => {
  const baseTime = 1700000000000;
  const sub = {
    id: "sub_3",
    charges_done: null,
    max_periods: null,
    period_seconds: null,
  };

  const patch = computeNextChargeState(sub, baseTime);

  assert.equal(patch.charges_done, 1);
  assert.equal(patch.status, undefined);
  assert.equal(patch.next_charge_at, new Date(baseTime + 30 * 86400 * 1000).toISOString());
});

test("isTerminalError - identifies terminal contract failure conditions", () => {
  assert.equal(isTerminalError("HostError: Error(Contract, #102) max_periods reached"), true);
  assert.equal(isTerminalError("mandate expired on ledger 451234"), true);
  assert.equal(isTerminalError("subscription expired"), true);
  assert.equal(isTerminalError("subscription not found"), true);

  // Transient network or rate limit errors are not terminal
  assert.equal(isTerminalError("fetch failed: ECONNREFUSED"), false);
  assert.equal(isTerminalError("timeout waiting for transaction confirmation"), false);
  assert.equal(isTerminalError("rpc rate limit exceeded 429"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBackoff,
  isTerminalError,
  computeNextChargeAt,
  isUnderBackoff,
  extractChargedResult,
  resolveDefaultContract,
  isValidContractId,
  resolveSubscriptionContract,
  processSubscription,
  MAINNET_DEFAULT_CONTRACT,
} from "./autocharge-scheduler.mjs";

test("resolveDefaultContract: resolves mainnet default or testnet config", () => {
  assert.equal(
    resolveDefaultContract("mainnet", undefined),
    MAINNET_DEFAULT_CONTRACT
  );
  assert.equal(
    resolveDefaultContract("public", undefined),
    MAINNET_DEFAULT_CONTRACT
  );
  assert.equal(
    resolveDefaultContract("testnet", undefined),
    null
  );
  assert.equal(
    resolveDefaultContract("testnet", "CCUSTOMTESTNETCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "CCUSTOMTESTNETCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
});

test("isValidContractId: verifies 56-char C... StrKey", () => {
  assert.equal(isValidContractId("CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U"), true);
  assert.equal(isValidContractId("GD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U"), false);
  assert.equal(isValidContractId("CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVF"), false);
  assert.equal(isValidContractId(null), false);
});

test("computeNextChargeAt: advances by contract nextDue or periodSeconds", () => {
  const nowMs = 1700000000000;
  const contractNextDue = 1700086400; // seconds
  const resultContract = computeNextChargeAt(nowMs, 86400, contractNextDue);
  assert.equal(resultContract, new Date(contractNextDue * 1000).toISOString());

  const periodSecs = 2592000; // 30 days
  const resultFallback = computeNextChargeAt(nowMs, periodSecs, null);
  assert.equal(resultFallback, new Date(nowMs + periodSecs * 1000).toISOString());
});

test("computeBackoff: computes exponential backoff within bounds", () => {
  assert.equal(computeBackoff(1, 600, 86400), 600); // 10 min
  assert.equal(computeBackoff(2, 600, 86400), 1200); // 20 min
  assert.equal(computeBackoff(3, 600, 86400), 2400); // 40 min
  assert.equal(computeBackoff(4, 600, 86400), 4800); // 80 min
  assert.equal(computeBackoff(10, 600, 86400), 86400); // capped at 24h
});

test("isTerminalError: recognizes terminal contract errors and rejects transient errors", () => {
  assert.equal(isTerminalError("HostError: Error(Contract, #5)"), true); // MaxPeriodsReached
  assert.equal(isTerminalError("sub error: maxperiodsreached"), true);
  assert.equal(isTerminalError("ContractError: Expired"), true);
  assert.equal(isTerminalError("mandate expired"), true);
  assert.equal(isTerminalError("Error(Contract, #3)"), true); // NotActive
  assert.equal(isTerminalError("network timeout"), false);
  assert.equal(isTerminalError("tx bad sequence"), false);
  assert.equal(isTerminalError("insufficient balance"), false);
});

test("isUnderBackoff: checks if subscription is within active backoff window", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  assert.equal(isUnderBackoff({ metadata: {} }, now), false);
  assert.equal(
    isUnderBackoff(
      { metadata: { next_retry_at: "2026-10-19T10:30:00Z" } },
      now
    ),
    true
  );
  assert.equal(
    isUnderBackoff(
      { metadata: { next_retry_at: "2026-10-19T09:30:00Z" } },
      now
    ),
    false
  );
});

test("processSubscription: advances next_charge_at and charges_done on success", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const sub = {
    id: "sub-123",
    soroban_contract_id: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
    soroban_subscription_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    next_charge_at: "2026-10-19T12:00:00Z",
    charges_done: 2,
    max_periods: 5,
    period_seconds: 86400,
    metadata: { consecutive_charge_failures: 2 },
  };

  let capturedPatch = null;
  const mockUpdate = async (id, patch) => {
    capturedPatch = { id, patch };
    return patch;
  };

  const mockAutocharge = async () => {
    return {
      hash: "abc123hash",
      status: "SUCCESS",
      returnValue: null,
      resultMetaXdr: null,
    };
  };

  const outcome = await processSubscription(sub, {}, {
    autochargeFn: mockAutocharge,
    updateSubscriptionFn: mockUpdate,
    now,
  });

  assert.equal(outcome.action, "success");
  assert.equal(outcome.hash, "abc123hash");
  assert.equal(outcome.charges_done, 3);

  assert.ok(capturedPatch);
  assert.equal(capturedPatch.id, "sub-123");
  assert.equal(capturedPatch.patch.charges_done, 3);
  assert.equal(capturedPatch.patch.last_charge_at, now.toISOString());
  // next_charge_at moved forward 1 period (86400s)
  const expectedNext = new Date(now.getTime() + 86400 * 1000).toISOString();
  assert.equal(capturedPatch.patch.next_charge_at, expectedNext);
  // failures cleared
  assert.equal(capturedPatch.patch.metadata.consecutive_charge_failures, 0);
  assert.equal(capturedPatch.patch.metadata.next_retry_at, null);
  assert.equal(capturedPatch.patch.metadata.last_charge_tx, "abc123hash");
  assert.equal(capturedPatch.patch.status, undefined); // stays active
});

test("processSubscription: marks expired when reaching max_periods on success", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const sub = {
    id: "sub-max",
    soroban_contract_id: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
    soroban_subscription_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    next_charge_at: "2026-10-19T12:00:00Z",
    charges_done: 4,
    max_periods: 5, // 4 + 1 = 5 == max_periods!
    period_seconds: 86400,
  };

  let capturedPatch = null;
  const mockUpdate = async (id, patch) => {
    capturedPatch = { id, patch };
    return patch;
  };

  const mockAutocharge = async () => {
    return { hash: "tx-terminal", status: "SUCCESS" };
  };

  const outcome = await processSubscription(sub, {}, {
    autochargeFn: mockAutocharge,
    updateSubscriptionFn: mockUpdate,
    now,
  });

  assert.equal(outcome.action, "success_expired");
  assert.equal(capturedPatch.patch.status, "expired");
  assert.equal(capturedPatch.patch.charges_done, 5);
});

test("processSubscription: marks expired on terminal contract error and leaves due set", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const sub = {
    id: "sub-terminal",
    soroban_contract_id: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
    soroban_subscription_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    next_charge_at: "2026-10-19T12:00:00Z",
    charges_done: 5,
    max_periods: 5,
    period_seconds: 86400,
  };

  let capturedPatch = null;
  const mockUpdate = async (id, patch) => {
    capturedPatch = { id, patch };
    return patch;
  };

  const mockAutocharge = async () => {
    throw new Error("sim: Error(Contract, #5) - MaxPeriodsReached");
  };

  const outcome = await processSubscription(sub, {}, {
    autochargeFn: mockAutocharge,
    updateSubscriptionFn: mockUpdate,
    now,
  });

  assert.equal(outcome.action, "expired");
  assert.ok(capturedPatch);
  assert.equal(capturedPatch.patch.status, "expired");
  assert.equal(capturedPatch.patch.next_charge_at, undefined); // NOT advanced!
});

test("processSubscription: leaves next_charge_at unchanged and sets backoff on transient failure", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const originalDue = "2026-10-19T11:50:00Z";
  const sub = {
    id: "sub-transient",
    soroban_contract_id: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
    soroban_subscription_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    next_charge_at: originalDue,
    charges_done: 1,
    max_periods: 10,
    period_seconds: 86400,
    metadata: { consecutive_charge_failures: 1 },
  };

  let capturedPatch = null;
  const mockUpdate = async (id, patch) => {
    capturedPatch = { id, patch };
    return patch;
  };

  const mockAutocharge = async () => {
    throw new Error("Soroban RPC 504 Gateway Timeout");
  };

  const outcome = await processSubscription(sub, {}, {
    autochargeFn: mockAutocharge,
    updateSubscriptionFn: mockUpdate,
    now,
  });

  assert.equal(outcome.action, "failed");
  assert.ok(capturedPatch);
  // CRITICAL: next_charge_at must NEVER be advanced on failure!
  assert.equal(capturedPatch.patch.next_charge_at, undefined);
  assert.equal(capturedPatch.patch.last_charge_at, undefined);
  // Consecutive failures incremented from 1 -> 2
  assert.equal(capturedPatch.patch.metadata.consecutive_charge_failures, 2);
  // Backoff calculated: 600 * 2^(2-1) = 1200 seconds (20 min)
  const expectedRetry = new Date(now.getTime() + 1200 * 1000).toISOString();
  assert.equal(capturedPatch.patch.metadata.next_retry_at, expectedRetry);
});

test("processSubscription: skips subscriptions under active backoff window", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const sub = {
    id: "sub-skipping",
    soroban_contract_id: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
    soroban_subscription_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    next_charge_at: "2026-10-19T11:00:00Z",
    metadata: {
      consecutive_charge_failures: 2,
      next_retry_at: "2026-10-19T12:20:00Z", // In future!
    },
  };

  let chargeCalled = false;
  const mockAutocharge = async () => {
    chargeCalled = true;
    return { status: "SUCCESS" };
  };

  const outcome = await processSubscription(sub, {}, {
    autochargeFn: mockAutocharge,
    now,
  });

  assert.equal(outcome.action, "skipped_backoff");
  assert.equal(chargeCalled, false);
});

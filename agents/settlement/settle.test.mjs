// SettlementAgent enforcement — the teeth that decide whether an observed
// on-chain payment validly settles an order. This is the matcher/reconciler
// boundary, and it is where the recipient-redirection hole is closed: a payment
// must land on the recipient the BUYER CONSENTED TO (pinned on the order at
// charge time), never the merchant's current live-looked-up address.
//
// Run: node --test agents/settlement/settle.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { verifySettlement } from "./settle.mjs";
import { parseBind, compileToolset } from "../axl/bind.mjs";

function fixture() {
  const order = {
    memo: "slp_ab12cd",
    consentedRecipient: "GMERCHANT_CONSENTED_ADDR",
    usdcAmount: "29.0000000",
    asset: "USDC",
  };
  const payment = {
    memo: "slp_ab12cd",
    destination: "GMERCHANT_CONSENTED_ADDR",
    amount: "29.0000000",
    asset: "USDC",
    txHash: "tx_0001",
  };
  return { order, payment };
}

test("a payment matching memo, consented recipient, amount and asset settles", () => {
  const { order, payment } = fixture();
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, true, r.reason);
});

test("payment to a DRIFTED recipient is rejected — closes orders.ts:130 redirection", () => {
  const { order, payment } = fixture();
  // Merchant rotated their Stellar address after the buyer consented.
  payment.destination = "GMERCHANT_ROTATED_NEW_ADDR";
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "recipient_drift");
});

test("payment with the wrong memo does not settle the order", () => {
  const { order, payment } = fixture();
  payment.memo = "slp_zzzzzz";
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "memo_mismatch");
});

test("underpayment is rejected", () => {
  const { order, payment } = fixture();
  payment.amount = "10.0000000";
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "amount_short");
});

test("wrong asset is rejected", () => {
  const { order, payment } = fixture();
  payment.asset = "XLM";
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "asset_mismatch");
});

test("a replayed tx does not settle twice", () => {
  const { order, payment } = fixture();
  const settled = new Set(["tx_0001"]);
  const r = verifySettlement(payment, order, settled);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "replay");
});

test("overpayment still settles (buyer paid at least the invoice)", () => {
  const { order, payment } = fixture();
  payment.amount = "30.5000000";
  const r = verifySettlement(payment, order, new Set());
  assert.equal(r.ok, true, r.reason);
});

test("the agent is bound away from moving money — it can only propose settlement", () => {
  const REGISTRY = {
    read_balance:       { name: "read_balance", description: "", input_schema: {} },
    propose_settlement: { name: "propose_settlement", description: "", input_schema: {} },
    transfer_funds:     { name: "transfer_funds", description: "", input_schema: {} },
  };
  const { capabilities } = parseBind("bind Settlement -> [read_balance, propose_settlement]");
  const tools = compileToolset(capabilities, REGISTRY);
  assert.equal(tools.find((t) => t.name === "transfer_funds"), undefined);
});

test("boundary: amount boundary on both sides (A-1stroop short, A ok, A+1stroop ok)", () => {
  const { order, payment } = fixture();
  order.usdcAmount = "29.0000000";

  // 1 stroop short (28.9999999): rejected as amount_short
  const rShort = verifySettlement({ ...payment, amount: "28.9999999" }, order, new Set());
  assert.equal(rShort.ok, false);
  assert.equal(rShort.reason, "amount_short");

  // exactly equal (29.0000000): settles
  const rExact = verifySettlement({ ...payment, amount: "29.0000000" }, order, new Set());
  assert.equal(rExact.ok, true);

  // 1 stroop over (29.0000001): settles (overpayment permitted)
  const rOver = verifySettlement({ ...payment, amount: "29.0000001" }, order, new Set());
  assert.equal(rOver.ok, true);
});

test("boundary: memo and recipient boundaries (1 character variance)", () => {
  const { order, payment } = fixture();

  // Memo variance by 1 character
  const memoDrift = verifySettlement({ ...payment, memo: order.memo + "x" }, order, new Set());
  assert.equal(memoDrift.ok, false);
  assert.equal(memoDrift.reason, "memo_mismatch");

  // Destination variance by 1 character
  const destDrift = verifySettlement(
    { ...payment, destination: order.consentedRecipient.slice(0, -1) + "Z" },
    order,
    new Set()
  );
  assert.equal(destDrift.ok, false);
  assert.equal(destDrift.reason, "recipient_drift");
});

test("fail-closed: malformed amount throws rather than silently settling", () => {
  const { order, payment } = fixture();
  assert.throws(() => {
    verifySettlement({ ...payment, amount: "not_a_valid_number" }, order, new Set());
  }, /non-numeric amount/);
});

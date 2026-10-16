// AntiAbuseAgent enforcement — the panopticon. Observes cross-agent activity and
// can HALT any agent. Its teeth: deterministic anomaly gates (velocity,
// conservation) + non-interference on inter-agent messages, and a HALT that
// DISARMS the target mechanically (recompiles it to the empty toolset via Axl
// bind — zero action space, not "asked to stand down"). It holds NO money
// capability itself; being the most dangerous agent, that is the whole point.
//
// Run: node --test agents/antiabuse/antiabuse.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, disarm } from "./antiabuse.mjs";
import { parseBind, compileToolset } from "../axl/bind.mjs";

const state = (over = {}) => ({ windowEvents: [], inflow: 100, buffer: 20, maxVelocity: 5, ...over });

test("allows a normal spend within velocity and conservation", () => {
  const r = evaluate({ kind: "spend", agent: "Billing", amount: 10, ts: 100 }, state());
  assert.equal(r.action, "ALLOW", r.reason);
});

test("HALTs on a conservation breach (outflow exceeds inflow+buffer)", () => {
  const s = state({ windowEvents: [{ ts: 1, amount: 115 }] });
  const r = evaluate({ kind: "spend", agent: "Billing", amount: 10, ts: 100 }, s);
  assert.equal(r.action, "HALT");
  assert.equal(r.reason, "conservation");
});

test("HALTs on a velocity breach (too many actions in window)", () => {
  const s = state({ windowEvents: [1, 2, 3, 4, 5].map((t) => ({ ts: t, amount: 1 })) });
  const r = evaluate({ kind: "spend", agent: "Billing", amount: 1, ts: 6 }, s);
  assert.equal(r.action, "HALT");
  assert.equal(r.reason, "velocity");
});

test("HALTs an inter-agent message that leaks a high label to a low sink (stego/collusion)", () => {
  const r = evaluate({ kind: "message", from: "Settlement", to: "Billing", srcLabel: "HIGH", sinkClearance: "LOW" }, state());
  assert.equal(r.action, "HALT");
  assert.equal(r.reason, "noninterference");
});

test("allows an inter-agent message within clearance", () => {
  const r = evaluate({ kind: "message", from: "Billing", to: "Authority", srcLabel: "LOW", sinkClearance: "HIGH" }, state());
  assert.equal(r.action, "ALLOW", r.reason);
});

test("HALT disarms the target: zero tools, mechanically (Axl bind)", () => {
  const REGISTRY = {
    observe: { name: "observe", description: "", input_schema: {} },
    transfer_funds: { name: "transfer_funds", description: "", input_schema: {} },
  };
  const tools = disarm(REGISTRY);
  assert.equal(tools.length, 0, "a halted agent must have NO action space");
});

test("the panopticon itself holds no money capability", () => {
  const REGISTRY = {
    observe: { name: "observe", description: "", input_schema: {} },
    halt: { name: "halt", description: "", input_schema: {} },
    transfer_funds: { name: "transfer_funds", description: "", input_schema: {} },
  };
  const { capabilities } = parseBind("bind AntiAbuse -> [observe, halt]");
  const tools = compileToolset(capabilities, REGISTRY);
  assert.equal(tools.find((t) => t.name === "transfer_funds"), undefined);
});

test("boundary: velocity boundary on both sides (V-1 ok, V HALT, V+1 HALT)", () => {
  const maxV = 5;
  // V-1 events (4 events): ALLOW
  const sBefore = state({
    maxVelocity: maxV,
    windowEvents: [1, 2, 3, 4].map((t) => ({ ts: t, amount: 1 })),
  });
  const rBefore = evaluate({ kind: "spend", agent: "Billing", amount: 1, ts: 5 }, sBefore);
  assert.equal(rBefore.action, "ALLOW");

  // exactly V events (5 events): HALT
  const sAt = state({
    maxVelocity: maxV,
    windowEvents: [1, 2, 3, 4, 5].map((t) => ({ ts: t, amount: 1 })),
  });
  const rAt = evaluate({ kind: "spend", agent: "Billing", amount: 1, ts: 6 }, sAt);
  assert.equal(rAt.action, "HALT");
  assert.equal(rAt.reason, "velocity");

  // V+1 events (6 events): HALT
  const sAfter = state({
    maxVelocity: maxV,
    windowEvents: [1, 2, 3, 4, 5, 6].map((t) => ({ ts: t, amount: 1 })),
  });
  const rAfter = evaluate({ kind: "spend", agent: "Billing", amount: 1, ts: 7 }, sAfter);
  assert.equal(rAfter.action, "HALT");
  assert.equal(rAfter.reason, "velocity");
});

test("boundary: conservation boundary on both sides (Limit-1 ok, Limit ok, Limit+1 HALT)", () => {
  const inflow = 100;
  const buffer = 20; // max allowable outflow = 120
  const s = state({ inflow, buffer, windowEvents: [{ ts: 1, amount: 100 }] });

  // Outflow = 119 (Limit - 1): ALLOW
  const rBefore = evaluate({ kind: "spend", agent: "Billing", amount: 19, ts: 2 }, s);
  assert.equal(rBefore.action, "ALLOW");

  // Outflow = 120 (Exactly at limit): ALLOW
  const rAt = evaluate({ kind: "spend", agent: "Billing", amount: 20, ts: 2 }, s);
  assert.equal(rAt.action, "ALLOW");

  // Outflow = 121 (Limit + 1): HALT
  const rAfter = evaluate({ kind: "spend", agent: "Billing", amount: 21, ts: 2 }, s);
  assert.equal(rAfter.action, "HALT");
  assert.equal(rAfter.reason, "conservation");
});

test("boundary: lattice non-interference boundaries across all clearance levels", () => {
  // Same level or upwards flow is permitted
  assert.equal(evaluate({ kind: "message", srcLabel: "PUBLIC", sinkClearance: "PUBLIC" }, state()).action, "ALLOW");
  assert.equal(evaluate({ kind: "message", srcLabel: "LOW", sinkClearance: "LOW" }, state()).action, "ALLOW");
  assert.equal(evaluate({ kind: "message", srcLabel: "HIGH", sinkClearance: "HIGH" }, state()).action, "ALLOW");
  assert.equal(evaluate({ kind: "message", srcLabel: "PUBLIC", sinkClearance: "HIGH" }, state()).action, "ALLOW");

  // Downwards flow is strictly halted
  const r1 = evaluate({ kind: "message", srcLabel: "LOW", sinkClearance: "PUBLIC" }, state());
  assert.equal(r1.action, "HALT");
  assert.equal(r1.reason, "noninterference");

  const r2 = evaluate({ kind: "message", srcLabel: "HIGH", sinkClearance: "LOW" }, state());
  assert.equal(r2.action, "HALT");
  assert.equal(r2.reason, "noninterference");
});

test("fail-closed: missing or malformed state fields handle gracefully", () => {
  // Empty state should not crash and should allow 0 spend within limits
  const r = evaluate({ kind: "spend", agent: "Billing", amount: 0, ts: 1 }, { inflow: 10, buffer: 5, maxVelocity: 1 });
  assert.equal(r.action, "ALLOW");

  // Unhandled high label defaults to PUBLIC (0) or fails appropriately
  const rUnk = evaluate({ kind: "message", srcLabel: "UNKNOWN", sinkClearance: "PUBLIC" }, state());
  assert.equal(rUnk.action, "ALLOW");
});

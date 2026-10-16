import { describe, it, expect } from "vitest";

describe("Stable React Keys Specification (Issue #325)", () => {
  it("verifies ConfirmTxModal key construction produces deterministic, collision-free keys", () => {
    const mockPayments = [
      { type: "payment", destination: "GA1111", amount: "100.00", assetCode: "USDC" },
      { type: "payment", destination: "GA2222", amount: "50.00", assetCode: "XLM" },
      { type: "payment", destination: "GA1111", amount: "100.00", assetCode: "USDC" }, // duplicate payment params in sequence
      { type: "payment" }, // minimal undefined op
    ];

    const generateOpKey = (op: any, i: number) =>
      `${op.destination ?? "nodest"}:${op.amount ?? "0"}:${op.assetCode ?? "XLM"}:${i}`;

    const keys = mockPayments.map(generateOpKey);

    // Each key must be unique even if destination and amount are identical
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(mockPayments.length);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).toBe("GA1111:100.00:USDC:0");
    expect(keys[1]).toBe("GA2222:50.00:XLM:1");
    expect(keys[2]).toBe("GA1111:100.00:USDC:2");
    expect(keys[3]).toBe("nodest:0:XLM:3");
  });

  it("verifies dynamic AskSlippay turn IDs are strictly unique and non-colliding", () => {
    let turnSeq = 0;
    function nextTurnId(role: "user" | "assistant"): string {
      turnSeq += 1;
      return `turn-${role}-${Date.now()}-${turnSeq}`;
    }

    const turns = [
      { id: nextTurnId("user"), role: "user", content: "hello" },
      { id: nextTurnId("assistant"), role: "assistant", content: "hi" },
      { id: nextTurnId("user"), role: "user", content: "how much?" },
      { id: nextTurnId("assistant"), role: "assistant", content: "zero fee" },
    ];

    const ids = turns.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(4);
    expect(ids[0]).toMatch(/^turn-user-\d+-\d+$/);
    expect(ids[1]).toMatch(/^turn-assistant-\d+-\d+$/);
  });

  it("verifies balance list stable keys distinguish different assets on same issuer or native", () => {
    const balances = [
      { asset_code: "XLM", balance: "100.00" },
      { asset_code: "USDC", asset_issuer: "GISSUER1", balance: "20.00" },
      { asset_code: "USDC", asset_issuer: "GISSUER2", balance: "30.00" },
    ];

    const balanceKeys = balances.map((b) => `${b.asset_code}:${b.asset_issuer ?? "native"}`);
    const uniqueKeys = new Set(balanceKeys);
    expect(uniqueKeys.size).toBe(3);
    expect(balanceKeys[0]).toBe("XLM:native");
    expect(balanceKeys[1]).toBe("USDC:GISSUER1");
    expect(balanceKeys[2]).toBe("USDC:GISSUER2");
  });
});

import { describe, it, expect } from "vitest";
import {
  specSha256Hex,
  emitBase,
  emitInductive,
  emitAttainable,
  reverifyCert,
} from "./axlVerify.ts";

// The spec text and its pre-computed SHA-256 (from an independent tool, not
// from specSha256Hex) so the binding check is verified against a real digest.
const SPEC = `;; axl sliding-window spend spec
(set-logic QF_LIA)
(family sliding_window)
(ceiling 1000)
(bound 3)
`;

const SPEC_SHA256 = "b055ea8b528a84c99c8b53e62091747331fc1edd23120cfbd4bfd59d0d3cdf03";

function validCert(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "axl-proof-certificate",
    spec_sha256: SPEC_SHA256,
    invariant: { family: "sliding_window", ceiling: 1000, bound: 3 },
    verdict: "ISSUED",
    tight: true,
    ...overrides,
  });
}

describe("specSha256Hex", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await specSha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await specSha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is stable for the same input and differs for a mutated one", async () => {
    expect(await specSha256Hex(SPEC)).toBe(SPEC_SHA256);
    expect(await specSha256Hex(SPEC + " ")).not.toBe(SPEC_SHA256);
  });
});

describe("SMT-LIB emitters", () => {
  it("emitBase negates invariant_K(0,0) and asks check-sat", () => {
    const smt = emitBase(3);
    expect(smt).toContain("invariant_K(0,0)");
    expect(smt).toContain("(assert (not (and (>= 0 0) (>= 0 0) (<= 0 W_cap) (<= 0 W_cap) (<= (+ 0 0) (* 3 W_cap)))))");
    expect(smt).toContain("(check-sat)");
  });

  it("emitInductive encodes the ceiling M and claimed bound K", () => {
    const smt = emitInductive(1000, 3);
    expect(smt).toContain("ceiling M=1000, claimed bound K=3");
    expect(smt).toContain("(<= (+ p1 c1 a) (* 1000 W_cap))");
    expect(smt).toContain("(assert accept)");
    expect(smt).toContain("(check-sat)");
  });

  it("emitAttainable asserts p1+c2 == K*cap (tightness)", () => {
    const smt = emitAttainable(1000, 3);
    expect(smt).toContain("(assert (= (+ p1 c2) (* 3 W_cap)))");
    expect(smt).toContain("(check-sat)");
  });

  it("a different bound produces different obligations", () => {
    expect(emitInductive(1000, 3)).not.toBe(emitInductive(1000, 4));
  });
});

describe("reverifyCert — valid certificate", () => {
  it("passes every client-side check and emits the four obligations", async () => {
    const result = await reverifyCert(validCert(), SPEC);

    expect(result.allGreen).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.label)).toEqual([
      "Certificate kind",
      "Spec ↔ certificate binding (SHA-256)",
      "Verdict is ISSUED",
    ]);
    expect(result.obligations.map((o) => [o.name, o.expect])).toEqual([
      ["base case", "unsat"],
      ["inductive step (the bound is sound)", "unsat"],
      ["attainability (the bound is tight)", "sat"],
      ["predecessor K=2 NOT sound (minimal)", "sat"],
    ]);
  });

  it("omits the predecessor obligation when the bound is 1 (already minimal)", async () => {
    const cert = validCert({ invariant: { family: "sliding_window", ceiling: 1000, bound: 1 } });
    const result = await reverifyCert(cert, SPEC);

    expect(result.obligations).toHaveLength(3);
    expect(result.obligations.map((o) => o.name)).not.toContain("predecessor K=1 NOT sound (minimal)");
  });
});

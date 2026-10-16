import { describe, it, expect } from "vitest";
import { compareCoverage } from "./check-coverage-ratchet.mjs";

describe("Coverage Ratchet Invariants", () => {
  const dummyBaseline = {
    "@slippay/shared": {
      lines: { pct: 90.0, covered: 90, total: 100 },
      statements: { pct: 90.0, covered: 90, total: 100 },
      functions: { pct: 100.0, covered: 10, total: 10 },
      branches: { pct: 80.0, covered: 80, total: 100 },
    },
    "@slippay/listener": {
      lines: { pct: 70.0, covered: 70, total: 100 },
      statements: { pct: 70.0, covered: 70, total: 100 },
      functions: { pct: 80.0, covered: 8, total: 10 },
      branches: { pct: 75.0, covered: 75, total: 100 },
    },
    "@slippay/web": {
      lines: { pct: 50.0, covered: 50, total: 100 },
      statements: { pct: 50.0, covered: 50, total: 100 },
      functions: { pct: 60.0, covered: 6, total: 10 },
      branches: { pct: 55.0, covered: 55, total: 100 },
    },
  };

  it("passes when current coverage exactly matches baseline", () => {
    const { regressions, improvements } = compareCoverage(dummyBaseline, dummyBaseline);
    expect(regressions).toHaveLength(0);
    expect(improvements).toHaveLength(0);
  });

  it("detects regressions when any metric drops below baseline", () => {
    const degraded = JSON.parse(JSON.stringify(dummyBaseline));
    degraded["@slippay/shared"].lines.pct = 85.5; // Dropped from 90.0 to 85.5
    degraded["@slippay/web"].branches.pct = 50.0; // Dropped from 55.0 to 50.0

    const { regressions, improvements } = compareCoverage(degraded, dummyBaseline);
    expect(regressions).toHaveLength(2);

    const sharedReg = regressions.find((r) => r.pkg === "@slippay/shared" && r.metric === "lines");
    expect(sharedReg).toBeDefined();
    expect(sharedReg.current).toBe(85.5);
    expect(sharedReg.baseline).toBe(90.0);
    expect(sharedReg.drop).toBe(4.5);

    const webReg = regressions.find((r) => r.pkg === "@slippay/web" && r.metric === "branches");
    expect(webReg).toBeDefined();
    expect(webReg.drop).toBe(5.0);
  });

  it("identifies improvements and advances ratchet upward only when update=true", () => {
    const improved = JSON.parse(JSON.stringify(dummyBaseline));
    improved["@slippay/listener"].lines.pct = 75.0; // Improved from 70.0 to 75.0

    const { regressions, improvements, updatedBaseline } = compareCoverage(
      improved,
      dummyBaseline,
      { update: true }
    );

    expect(regressions).toHaveLength(0);
    expect(improvements).toHaveLength(1);
    expect(improvements[0].pkg).toBe("@slippay/listener");
    expect(improvements[0].metric).toBe("lines");
    expect(improvements[0].gain).toBe(5.0);

    // Assert that the new baseline ratchet moved up
    expect(updatedBaseline["@slippay/listener"].lines.pct).toBe(75.0);
    // Other metrics stayed at original baseline
    expect(updatedBaseline["@slippay/listener"].statements.pct).toBe(70.0);
  });

  it("tolerates floating point rounding within tolerance", () => {
    const slightlyDifferent = JSON.parse(JSON.stringify(dummyBaseline));
    slightlyDifferent["@slippay/shared"].lines.pct = 89.995; // 0.005 drop, within 0.01 tolerance

    const { regressions } = compareCoverage(slightlyDifferent, dummyBaseline, { tolerance: 0.01 });
    expect(regressions).toHaveLength(0);
  });

  it("never ratchets downward when update=true if regression occurs", () => {
    const degraded = JSON.parse(JSON.stringify(dummyBaseline));
    degraded["@slippay/listener"].functions.pct = 60.0; // 80 -> 60

    const { regressions, updatedBaseline } = compareCoverage(
      degraded,
      dummyBaseline,
      { update: true }
    );

    expect(regressions).toHaveLength(1);
    // Ratchet MUST NOT decrease
    expect(updatedBaseline["@slippay/listener"].functions.pct).toBe(80.0);
  });
});

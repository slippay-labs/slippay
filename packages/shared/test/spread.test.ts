import { describe, expect, it } from "vitest";
import { DEFAULT_FX_SPREAD_BP, MAX_FX_SPREAD_BP } from "../src/constants";
import { parseSpreadBps } from "../src/spread";

describe("parseSpreadBps", () => {
  it("falls back to the default when unset", () => {
    expect(parseSpreadBps(undefined)).toBe(DEFAULT_FX_SPREAD_BP);
    expect(parseSpreadBps(null)).toBe(DEFAULT_FX_SPREAD_BP);
  });

  it("accepts whole numbers inside the bounds", () => {
    expect(parseSpreadBps("190")).toBe(190);
    expect(parseSpreadBps(" 250 ")).toBe(250);
    expect(parseSpreadBps("0")).toBe(0);
    expect(parseSpreadBps(String(MAX_FX_SPREAD_BP))).toBe(MAX_FX_SPREAD_BP);
    expect(parseSpreadBps(300)).toBe(300);
  });

  it("rejects values above the maximum", () => {
    expect(() => parseSpreadBps(String(MAX_FX_SPREAD_BP + 1))).toThrow(RangeError);
    expect(() => parseSpreadBps("10001")).toThrow(RangeError);
    expect(() => parseSpreadBps("99999999999999999999")).toThrow(RangeError);
  });

  it("rejects negative values (a negative spread pays users to convert)", () => {
    expect(() => parseSpreadBps("-1")).toThrow(RangeError);
    expect(() => parseSpreadBps(-190)).toThrow(RangeError);
  });

  it("rejects non-numeric and malformed values instead of producing NaN", () => {
    for (const bad of ["abc", "", "   ", "1.5", "1e2", "NaN", "Infinity", "0x10", "190bps"]) {
      expect(() => parseSpreadBps(bad)).toThrow(RangeError);
    }
    expect(() => parseSpreadBps(Number.NaN)).toThrow(RangeError);
    expect(() => parseSpreadBps(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => parseSpreadBps(1.5)).toThrow(RangeError);
  });

  it("names the variable and the allowed range in the error", () => {
    expect(() => parseSpreadBps("abc")).toThrow(
      `Invalid VITE_FX_SPREAD_BPS: expected a whole number of basis points between 0 and ${MAX_FX_SPREAD_BP}, got "abc".`,
    );
  });
});

describe("FX spread constants", () => {
  it("keeps the default inside the documented bounds", () => {
    expect(Number.isInteger(DEFAULT_FX_SPREAD_BP)).toBe(true);
    expect(DEFAULT_FX_SPREAD_BP).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_FX_SPREAD_BP).toBeLessThanOrEqual(MAX_FX_SPREAD_BP);
  });
});
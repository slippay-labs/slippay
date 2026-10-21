import { DEFAULT_FX_SPREAD_BP, MAX_FX_SPREAD_BP } from "./constants";

const ENV_NAME = "VITE_FX_SPREAD_BPS";

function fail(received: unknown): never {
  throw new RangeError(
    `Invalid ${ENV_NAME}: expected a whole number of basis points between 0 and ${MAX_FX_SPREAD_BP}, got "${String(received)}".`,
  );
}

/**
 * Parse the FX spread configuration (basis points).
 *
 * - undefined / null  -> DEFAULT_FX_SPREAD_BP
 * - a whole number from 0 to MAX_FX_SPREAD_BP (as a number or digit string) -> that value
 * - anything else (empty, negative, decimal, "abc", "1e2", NaN, too large) -> throws
 */
export function parseSpreadBps(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_FX_SPREAD_BP;
  }

  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return fail(raw);
  }

  if (!Number.isInteger(value) || value < 0 || value > MAX_FX_SPREAD_BP) {
    return fail(raw);
  }
  return value;
}
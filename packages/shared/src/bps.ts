import { z } from "zod";

/**
 * Shared, bounded basis-point schemas.
 *
 * A basis point is a bounded quantity: 1 bp = 0.01%. We allow 0-1000 bp
 * (0%-10%) for fees and spreads. Every fee/spread input must be parsed
 * through these schemas at the boundary so the client and the edge cannot
 * diverge, and out-of-range values fail closed.
 */

export const BPS_MIN = 0;
export const BPS_MAX = 1000;

/** Bounded integer basis-points (0-1000 bp == 0%-10%). */
export const BpsSchema = z.number().int().min(BPS_MIN).max(BPS_MAX);

/** Parse a bp value, throwing a clear error on out-of-range input. */
export function parseBps(value: unknown, label = "bps"): number {
  const result = BpsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} must be an integer between ${BPS_MIN} and ${BPS_MAX} bp, got ${String(value)}`,
    );
  }
  return result.data;
}

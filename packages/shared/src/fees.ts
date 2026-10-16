/**
 * Maximum platform fee in basis points (bp).
 *
 * This is the single source of truth for the fee bound. It must match the
 * `constraint on the `orders` table (`between 0 and 1000`), i.e. at most 10%.
 *
 * The listener and the database must agree on this bound; a bound that
 * exists in two places is a bound that will differ.
 */
export const MAX_PLATFORM_FEE_BP = 1000;

/**
 * Returns true when a fee basis-points value is within the accepted
 * bound [0, MAX_PLATFORM_FEE_BP] and is a finite integer.
 */
export function isValidPlatformFeePb(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return false;
  if (value < 0) return false;
  if (value > MAX_PLATFORM_FEE_BP) return false;
  return true;
}

/**
 * Slippay margin maths — single source of truth for both ramp directions.
 *
 * Money never touches floating point formatting here: amounts are scaled to
 * integer minor units (cents, or 1e-6 for stablecoins), the margin is applied
 * as integer basis points, and the result is rounded DOWN so any sub-unit
 * remainder stays with the platform rather than being handed to the user.
 */

/** Basis points are integers in [0, 1000] = 0%..10%. */
export const MAX_MARGIN_BPS = 1000;
export const DEFAULT_MARGIN_BPS = 280;

export function resolveMarginBps(raw: unknown, fallback = DEFAULT_MARGIN_BPS): number {
  const bps = Number(raw);
  if (!Number.isFinite(bps) || bps < 0 || bps > MAX_MARGIN_BPS) return fallback;
  return Math.trunc(bps);
}

/** Decimal -> integer minor units, rounded to the nearest unit of the input. */
export function toMinorUnits(amount: number, decimals: number): number {
  return Math.round(amount * 10 ** decimals);
}

/**
 * Apply a basis-point margin to a decimal amount and return the net decimal.
 *
 * Rounding direction is explicit: the net is floored at the minor-unit level,
 * i.e. rounded in the platform's favour, so the settled amount can never exceed
 * the amount quoted to the user.
 */
export function applyMargin(amount: number, marginBps: number, decimals: number): number {
  if (!Number.isFinite(amount)) return amount;
  const bps = resolveMarginBps(marginBps, 0);
  const units = toMinorUnits(amount, decimals);
  const netUnits = Math.floor((units * (10_000 - bps)) / 10_000);
  return netUnits / 10 ** decimals;
}

/** Integer net for assertions and ledger use. */
export function applyMarginMinor(amount: number, marginBps: number, decimals: number): number {
  const bps = resolveMarginBps(marginBps, 0);
  const units = toMinorUnits(amount, decimals);
  return Math.floor((units * (10_000 - bps)) / 10_000);
}

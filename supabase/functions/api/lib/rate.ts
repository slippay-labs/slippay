import {
  getBrlPerUsdc as sharedGetBrlPerUsdc,
  _resetRateCacheForTest,
  _resetRateInFlightForTest,
  RateUnavailableError,
  type RateResult,
  type RateOptions,
} from "@slippay/shared";

export { RateUnavailableError };
export type { RateResult, RateOptions };

export function _resetCacheForTest(): void {
  _resetRateCacheForTest();
  _resetRateInFlightForTest();
}

/**
 * Returns the current BRL per USDC mid-market rate.
 * Leverages Singleflight stampede protection, bounded-latency timeouts,
 * automatic exponential backoff retries, and graceful fallback downgrade.
 */
export async function getBrlPerUsdc(options?: RateOptions): Promise<number> {
  const res = await sharedGetBrlPerUsdc(options);
  return res.rate;
}

/**
 * Returns full rate details including stale flag and rate source (env/live/cache/fallback).
 */
export async function getBrlPerUsdcDetail(options?: RateOptions): Promise<RateResult> {
  return sharedGetBrlPerUsdc(options);
}

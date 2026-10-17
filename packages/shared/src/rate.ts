import {
  DEFAULT_FALLBACK_BRL_PER_USDC,
  DEFAULT_RATE_FETCH_TIMEOUT_MS,
  DEFAULT_RATE_FETCH_MAX_RETRIES,
  DEFAULT_RATE_CACHE_TTL_MS,
  RATE_COINGECKO_URL,
} from "./constants.ts";

export class RateUnavailableError extends Error {
  readonly code = "rate_unavailable" as const;
  readonly status = 503;

  constructor(message = "Upstream FX rate unavailable", public readonly cause?: unknown) {
    super(message);
    this.name = "RateUnavailableError";
  }
}

export type RateSource = "env" | "live" | "cache" | "fallback";

export interface RateResult {
  rate: number;
  stale: boolean;
  source: RateSource;
}

export interface RateOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  fallbackRate?: number;
  allowFallback?: boolean;
  ttlMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  envGetter?: (key: string) => string | undefined;
}

let cache: { rate: number; stale: boolean; source: RateSource; expires: number } | null = null;
let inFlightPromise: Promise<RateResult> | null = null;

export function _resetRateCacheForTest(): void {
  cache = null;
}

export function _resetRateInFlightForTest(): void {
  inFlightPromise = null;
}

export function getRateCacheStatus(): { hasCache: boolean; expires: number | null; inFlight: boolean } {
  return {
    hasCache: cache !== null,
    expires: cache?.expires ?? null,
    inFlight: inFlightPromise !== null,
  };
}

function resolveEnv(key: string, envGetter?: (k: string) => string | undefined): string | undefined {
  if (envGetter) {
    try {
      return envGetter(key);
    } catch {
      // ignore
    }
  }
  // Try Deno.env
  try {
    // @ts-ignore - Deno global check
    if (typeof Deno !== "undefined" && typeof Deno.env?.get === "function") {
      // @ts-ignore
      return Deno.env.get(key);
    }
  } catch {
    // ignore
  }
  // Try process.env
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env[key];
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Fetch CoinGecko with timeout, bounded retries and exponential backoff.
 */
async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  maxRetries: number,
  backoffMs: number,
  sleepFn: (ms: number) => Promise<void>
): Promise<number> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleepFn(backoffMs * Math.pow(2, attempt - 1));
    }

    const controller = new AbortController();
    let timer: any = null;
    try {
      timer = setTimeout(() => {
        controller.abort(new Error(`Upstream rate request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`coingecko ${res.status}`);
      }
      const data = (await res.json()) as { "usd-coin"?: { brl?: number } };
      const val = data?.["usd-coin"]?.brl;
      if (typeof val !== "number" || val <= 0 || !Number.isFinite(val)) {
        throw new Error("bad rate response");
      }
      return val;
    } catch (err: unknown) {
      lastError = err;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  throw lastError;
}

/**
 * Get current BRL per USDC rate with Singleflight stampede protection,
 * bounded latency timeout, exponential backoff retries, and fallback downgrade.
 */
export async function getBrlPerUsdc(options: RateOptions = {}): Promise<RateResult> {
  const envOverride = resolveEnv("RATE_BRL_USDC", options.envGetter);
  if (envOverride) {
    const v = parseFloat(envOverride);
    if (v > 0 && Number.isFinite(v)) {
      return { rate: v, stale: false, source: "env" };
    }
  }

  const nowFn = options.nowFn ?? (() => Date.now());
  const now = nowFn();

  // Return non-expired cache if available
  if (cache && cache.expires > now) {
    return {
      rate: cache.rate,
      stale: cache.stale,
      source: "cache",
    };
  }

  // Cache-stampede guard: share in-flight promise across concurrent callers
  if (inFlightPromise) {
    return inFlightPromise;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RATE_FETCH_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RATE_FETCH_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? 100;
  const fallbackRate = options.fallbackRate ?? DEFAULT_FALLBACK_BRL_PER_USDC;
  const ttlMs = options.ttlMs ?? DEFAULT_RATE_CACHE_TTL_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Fallback enabled unless explicitly disabled via options or RATE_ALLOW_FALLBACK=false
  let allowFallback = options.allowFallback ?? true;
  const envAllowFallback = resolveEnv("RATE_ALLOW_FALLBACK", options.envGetter);
  if (envAllowFallback === "false" || envAllowFallback === "0") {
    allowFallback = false;
  }

  inFlightPromise = (async (): Promise<RateResult> => {
    try {
      const val = await fetchWithRetry(
        fetchFn,
        RATE_COINGECKO_URL,
        timeoutMs,
        maxRetries,
        backoffMs,
        sleepFn
      );
      const res: RateResult = { rate: val, stale: false, source: "live" };
      cache = { ...res, expires: nowFn() + ttlMs };
      return res;
    } catch (err: unknown) {
      if (allowFallback) {
        // Controlled, safe downgrade to documented fallback
        const res: RateResult = { rate: fallbackRate, stale: true, source: "fallback" };
        cache = { ...res, expires: nowFn() + Math.min(ttlMs, 10_000) }; // Fallback cached shortly
        return res;
      }
      throw new RateUnavailableError("Failed to fetch upstream FX rate after retries", err);
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}

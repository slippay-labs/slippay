import { supabase } from "./auth.tsx";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";
const DEFAULT_TIMEOUT_MS = 30_000;

// Composes multiple AbortSignals into one. The first to abort wins.
// If any signal is already aborted, the composed signal is immediately aborted.
function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  if (active.length === 0) {
    // No signals supplied – return a long-lived signal that never aborts.
    const { signal } = AbortController.timeout(Infinity);
    return signal;
  }
  if (active.length === 1) return active[0];
  const composed = AbortSignal.any(active);
  // If any signal is already aborted, trigger immediately.
  for (const s of active) {
    if (s.aborted) {
      composed.abort();
      break;
    }
    s.addEventListener("abort", () => composed.abort(), { once: true });
  }
  return composed;
}

/** Error thrown when a fetch times out via AbortSignal.timeout(). */
class TimeoutError extends Error {
  declare readonly timeout: true;
  constructor(timeoutMs: number) {
    super(`Network request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeout = true;
  }
}

export async function authFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;

  const signal = composeSignals(
    init.signal,
    AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  );

  // If the composed signal is already aborted (e.g. caller pre-aborted),
  // throw a TimeoutError so the caller can distinguish it from a network error.
  if (signal.aborted) {
    throw new TimeoutError(DEFAULT_TIMEOUT_MS);
  }

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    signal,
  });
}
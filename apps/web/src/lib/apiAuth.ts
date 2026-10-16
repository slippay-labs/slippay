import { supabase } from "./auth.tsx";

export const DEFAULT_API_BASE = "/api";
export const API_BASE = import.meta.env.VITE_API_BASE ?? DEFAULT_API_BASE;
export const DEFAULT_TIMEOUT_MS = 15000;

function combineSignals(callerSignal?: AbortSignal | null, timeoutSignal?: AbortSignal | null): AbortSignal | undefined {
  if (!callerSignal && !timeoutSignal) return undefined;
  if (!callerSignal) return timeoutSignal ?? undefined;
  if (!timeoutSignal) return callerSignal;
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([callerSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(callerSignal.aborted ? callerSignal.reason : timeoutSignal.reason);
  };
  if (callerSignal.aborted || timeoutSignal.aborted) {
    onAbort();
    return controller.signal;
  }
  callerSignal.addEventListener("abort", onAbort, { once: true });
  timeoutSignal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export interface AuthFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Robust authenticated fetch transport for @slippay/web.
 *
 * Normalizes headers using standard Headers API (supporting plain objects,
 * Headers instances, and arrays of pairs). Implements configurable timeout,
 * composite abort signals, and a single-replay 401 token refresh mechanism
 * that strictly prevents infinite retry loops.
 */
export async function authFetch(path: string, init: AuthFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init;

  const timeoutSignal = timeoutMs > 0 && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  const signal = combineSignals(fetchInit.signal, timeoutSignal);

  const { data } = await supabase.auth.getSession();
  let jwt = data.session?.access_token;

  function buildHeaders(token?: string): Headers {
    const h = new Headers(fetchInit.headers);
    if (token && !h.has("authorization")) {
      h.set("authorization", `Bearer ${token}`);
    }
    return h;
  }

  const url = `${API_BASE}${path}`;

  let res = await fetch(url, {
    ...fetchInit,
    headers: buildHeaders(jwt),
    signal,
  });

  // Single refresh & replay on 401
  if (res.status === 401 && jwt) {
    try {
      let refreshedToken: string | undefined;
      if (typeof (supabase.auth as any).refreshSession === "function") {
        const refreshRes = await (supabase.auth as any).refreshSession();
        refreshedToken = refreshRes.data?.session?.access_token;
      } else {
        const sessionRes = await supabase.auth.getSession();
        refreshedToken = sessionRes.data?.session?.access_token;
      }

      if (refreshedToken && refreshedToken !== jwt) {
        res = await fetch(url, {
          ...fetchInit,
          headers: buildHeaders(refreshedToken),
          signal,
        });
      }
    } catch {
      // Refresh error surfaces original 401 without looping
    }
  }

  return res;
}

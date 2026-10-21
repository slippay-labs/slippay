import { supabase } from "./auth.tsx";
import { DEV_LOOPBACK_BASE, resolveApiBase } from "./apiBase.ts";


// Resolve the API base at startup. In a production build a missing or plaintext
// non-loopback VITE_API_BASE throws here rather than silently sending the
// caller's bearer JWT over cleartext HTTP.
const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE as string | undefined, {
  dev: Boolean(import.meta.env.DEV),
  name: "VITE_API_BASE",
  devFallback: DEV_LOOPBACK_BASE,
});

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
  });
}

/** The resolved API base (for tests + debugging). */
export const API_BASE_URL = API_BASE;

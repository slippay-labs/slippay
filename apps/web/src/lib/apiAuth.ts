import { supabase } from "./auth.tsx";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

export async function authFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;

  const initHeaders: Record<string, string> = {
    ...init.headers,
    ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: initHeaders,
  });

  // If the initial request returns 401, attempt a single session refresh
  // and retry the request once.
  if (res.status === 401) {
    const refreshed = await supabase.auth.refreshSession();
    const jwt2 = refreshed.data.session?.access_token;

    const initHeaders2: Record<string, string> = {
      ...init.headers,
      ...(jwt2 ? { authorization: `Bearer ${jwt2}` } : {}),
    };

    const res2 = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: initHeaders2,
    });

    return res2;
  }

  return res;
}
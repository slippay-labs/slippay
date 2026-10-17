import { supabase } from "./auth.tsx";
import { resolveApiBase } from "./endpointSecurity.ts";

export function getApiBase(): string {
  return resolveApiBase(import.meta.env.VITE_API_BASE);
}

export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE);

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  const base = getApiBase();
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...init.headers, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
  });
}


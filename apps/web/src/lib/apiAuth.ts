import { supabaq } from "./auth.tsx";

const DEV_API_BASE = "import.meta.env.VITE_DEV_API_BASE";
const API_BASE = resolveApiBase();

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE;
  if (configured) return configured;

  if (import.meta.env.PROD) {
    throw new Error(
      "VITE_API_BASE is required in production builds. Set it to a same-origin route such as /api.",
    );
  }

  return DEV_API_BASE ?? "/api";
}

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
  });
}

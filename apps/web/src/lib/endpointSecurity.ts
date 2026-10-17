/**
 * Safe endpoint resolution and protocol enforcement.
 *
 * Problem (Issue #197):
 * Defaulting to plaintext HTTP loopback (`http://127.0.0.1:54321/...`) is
 * convenient in local development, but in production it risks leaking bearer
 * tokens and credentials across cleartext or unencrypted hops if unset or
 * misconfigured to an insecure host (e.g. `http://api.slippay.cc/...`).
 *
 * Rules:
 * 1. Any configured endpoint must parse as a valid URL.
 * 2. Any non-loopback host MUST use the `https:` protocol. Plaintext `http:` is
 *    strictly rejected for non-loopback hosts.
 * 3. In production (`!isDev`), `VITE_API_BASE` is strictly required — the loopback
 *    default is completely unreachable in production builds.
 * 4. The loopback default (`http://127.0.0.1:54321/functions/v1/api`) is only
 *    permitted in development mode (`isDev === true`).
 */

export const DEV_DEFAULT_API_BASE = "http://127.0.0.1:54321/functions/v1/api";
export const CANONICAL_RELAYER_BASE = "https://api.slippay.cc/api/v1/relayer";

/**
 * Returns true if the hostname is a recognized local loopback address.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost")
  );
}

/**
 * Asserts that a URL string is valid and adheres to the secure protocol policy.
 *
 * Non-loopback endpoints must always use `https:`.
 */
export function assertSecureEndpoint(urlStr: string, varName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL configured for ${varName}: "${urlStr}"`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}" configured for ${varName}: "${urlStr}". Expected https: or http: for loopback.`
    );
  }

  if (protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `Insecure HTTP protocol not allowed for non-loopback endpoint ${varName}: "${urlStr}". Use https:// instead.`
    );
  }

  // Strip trailing slash for consistent route composition
  return urlStr.replace(/\/+$/, "");
}

/**
 * Resolves the active API base URL.
 *
 * - In development (`isDev = true`), falls back to local Supabase functions loopback if unset.
 * - In production (`isDev = false`), throws immediately if unset or misconfigured.
 */
export function resolveApiBase(
  rawVal?: string,
  isDev: boolean = import.meta.env?.DEV ?? false
): string {
  const trimmed = rawVal?.trim();
  if (trimmed && trimmed.length > 0) {
    return assertSecureEndpoint(trimmed, "VITE_API_BASE");
  }

  if (isDev) {
    return DEV_DEFAULT_API_BASE;
  }

  throw new Error(
    "VITE_API_BASE is required in production builds but was not configured. Plaintext loopback fallback is only permitted in development."
  );
}

/**
 * Resolves the relayer base URL. Defaults to the canonical HTTPS production endpoint.
 */
export function resolveRelayerBase(
  rawVal?: string,
  _isDev: boolean = import.meta.env?.DEV ?? false
): string {
  const trimmed = rawVal?.trim();
  if (trimmed && trimmed.length > 0) {
    return assertSecureEndpoint(trimmed, "VITE_RELAYER_BASE");
  }
  return CANONICAL_RELAYER_BASE;
}

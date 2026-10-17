import { API_KEY_PREFIX, API_KEY_BYTES, bufToHex, DEFAULT_LEGACY_API_KEY_SUNSET } from "@slippay/shared";

// Audit-004 · C4 & Issue #193: API keys are hashed with HMAC-SHA-256 using a server-side
// pepper. The legacy unsalted SHA-256 compatibility branch is time-boxed and rejects
// authentication once the sunset deadline passes.
export const LEGACY_API_KEY_SUNSET_DATE = Deno.env.get("LEGACY_API_KEY_SUNSET_DATE") ?? DEFAULT_LEGACY_API_KEY_SUNSET;

const ENC = new TextEncoder();
let HMAC_KEY_CACHE: CryptoKey | null = null;

export function _resetKeyCacheForTest() {
  HMAC_KEY_CACHE = null;
}

function getPepper(): string {
  const p = Deno.env.get("API_KEY_PEPPER") ?? "0".repeat(32);
  if (p.length < 32) throw new Error("API_KEY_PEPPER too short (<32 chars)");
  return p;
}

async function hmacKey(): Promise<CryptoKey> {
  if (HMAC_KEY_CACHE) return HMAC_KEY_CACHE;
  HMAC_KEY_CACHE = await crypto.subtle.importKey(
    "raw",
    ENC.encode(getPepper()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return HMAC_KEY_CACHE;
}

export function generateApiKey(): { plain: string } {
  const bytes = new Uint8Array(API_KEY_BYTES);
  crypto.getRandomValues(bytes);
  const hex = bufToHex(bytes);
  return { plain: API_KEY_PREFIX + hex };
}

/** Canonical hash for new keys: HMAC-SHA-256(pepper, plain). */
export async function hashApiKey(plain: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(plain));
  return bufToHex(sig);
}

/** Legacy unsalted SHA-256, time-boxed for rotation until sunset. */
export async function legacyHashApiKey(plain: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", ENC.encode(plain));
  return bufToHex(buf);
}

/**
 * Returns the effective sunset deadline date string.
 */
export function getLegacyApiKeySunsetDate(): string {
  return Deno.env.get("LEGACY_API_KEY_SUNSET_DATE") ?? DEFAULT_LEGACY_API_KEY_SUNSET;
}

/**
 * Checks whether the legacy unpeppered API key hash scheme has reached its sunset deadline.
 */
export function isLegacyApiKeySunset(now: number = Date.now()): boolean {
  const deadline = getLegacyApiKeySunsetDate();
  const deadlineMs = Date.parse(deadline);
  if (isNaN(deadlineMs)) return true;
  return now >= deadlineMs;
}

export async function verifyApiKey(plain: string, hash: string, options?: { now?: number }): Promise<boolean> {
  // 1. Try canonical peppered hash first
  const peppered = await hashApiKey(plain);
  if (constantTimeEqual(peppered, hash)) return true;

  // 2. Fallback to legacy SHA-256 only if sunset deadline has not passed (Issue #193)
  if (isLegacyApiKeySunset(options?.now)) {
    return false;
  }

  const legacy = await legacyHashApiKey(plain);
  return constantTimeEqual(legacy, hash);
}

/**
 * Operational metric helper: reports count of merchants still relying on legacy SHA-256 keys.
 */
export async function getLegacyHashMerchantCount(sb: {
  from: (table: string) => {
    select: (cols: string, opts?: { count?: string; head?: boolean }) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => Promise<{ count: number | null; error: unknown }>;
      };
    };
  };
}): Promise<number> {
  const { count, error } = await sb
    .from("merchants")
    .select("id", { count: "exact", head: true })
    .eq("api_key_scheme", "legacy_sha256")
    .eq("active", true);

  if (error) {
    console.error("[ERROR] Failed to query legacy hash merchant count:", error);
    return 0;
  }
  return count ?? 0;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function prefixOf(plain: string, n = 4): string {
  return plain.slice(0, API_KEY_PREFIX.length + n);
}

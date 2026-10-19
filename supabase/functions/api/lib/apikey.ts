import { API_KEY_PREFIX, API_KEY_BYTES, bufToHex } from "@slippay/shared";

// Audit-004 · C4 — API keys are hashed with HMAC-SHA-256 using a server-side
// pepper, so a DB-only leak (Supabase breach, backup theft, support engineer
// with read-only access) is not enough to brute-force a key. The pepper lives
// in `API_KEY_PEPPER` env (≥32 bytes) and never touches the database.
//
// We accept SHA-256 hashes too (legacy unsalted) on read to allow a graceful
// rotation: once all merchants have rotated keys via /me/rotate-key, drop the
// legacy branch.

const ENC = new TextEncoder();
let HMAC_KEY_CACHE: CryptoKey | null = null;

function getPepper(): string {
  const p = Deno.env.get("API_KEY_PEPPER");
  if (!p) throw new Error("API_KEY_PEPPER not set");
  if (p.length < 32) throw new Error("API_KEY_PEPPER too short (<32 chars)");
  return p;
}

async function hmacKey(): Promise<CryptoKey> {
  if (HMAC_KEY_CACHE) return HMAC_KEY_CACHE;
  HMAC_KEY_CACHE = await crypto.subtle.importKey(
    "raw", ENC.encode(getPepper()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
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

/** Legacy unsalted SHA-256, kept for read-side compat during rotation only. */
async function legacyHashApiKey(plain: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", ENC.encode(plain));
  return bufToHex(buf);
}

/**
 * Every hash a key may be stored under during the rotation window: the
 * canonical peppered HMAC first, then the legacy unsalted SHA-256.
 *
 * Both `verifyApiKey` and the auth middleware must derive their lookup values
 * from this function. When the rotation is complete, deleting the legacy
 * branch in this one place removes it from every caller.
 */
export async function hashCandidates(plain: string): Promise<string[]> {
  return [await hashApiKey(plain), await legacyHashApiKey(plain)];
}

export async function verifyApiKey(plain: string, hash: string): Promise<boolean> {
  // Accept either candidate, comparing each in constant time.
  for (const candidate of await hashCandidates(plain)) {
    if (constantTimeEqual(candidate, hash)) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Audit-004 · C4 — prefix shortened from 16 to 4 chars. The prefix is shown
// in the dashboard for "last 4 of api_key sk_live_xxxx" display purposes only.
// 16 chars revealed 8 bytes of entropy in a leaked dump — overkill for UX,
// dangerous if combined with a hash leak.
export function prefixOf(plain: string, n = 4): string {
  return plain.slice(0, API_KEY_PREFIX.length + n);
}

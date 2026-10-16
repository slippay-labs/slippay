const TOLERANCE_S = 300;

/**
 * Memo encoding convention (documented once, referenced by both the
 * generator in `lib/memo.ts` and the matcher in `apps/listener/src/matcher.ts`).
 *
 * On-chain memos are base64-encoded 32-byte values. The canonical hex form
 * is the lowercase hex encoding of those 32 bytes (64 hex characters).
 */
export const MEMO_BYTES = 32;
export const MEMO_HEX_LEN = MEMO_BYTES * 2;

/**
 * Decode a base64 memo and validate it is exactly `MEMO_BYTES` long.
 *
 * `Buffer.from(..., "base64")` is lenient: it silently drops invalid
 * characters, so a malformed or truncated memo decodes to some buffer
 * rather than being rejected. We re-encode and compare to reject inputs
 * that are not canonical base64 for exactly `MEMO_BYTES` bytes.
 *
 * Returns the canonical lowercase hex form, or `null` if malformed.
 */
export function decodeMemoHex(memoB64: string): string | null {
  const buf = Buffer.from(memoB64, "base64");
  if (buf.length !== MEMO_BYTES) return null;
  if (buf.toString("base64") !== memoB64) return null;
  return buf.toString("hex");
}

export async function signWebhook(secret: string, body: string, t: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const data = enc.encode(`${t}.${body}`);
  const buf = await crypto.subtle.sign("HMAC", key, data);
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
  return `t=${t},v1=${hex}`;
}

/**
 * Constant-time string comparison.
 *
 * Always runs the comparison loop over the longer of the two inputs,
 * including on length mismatch, so time and early exit do not leak the
 * length or content of either value. This matches the convention used
 * by the API key verifier and the PHP receiver's `hash_equals`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function verifyWebhook(secret: string, body: string, header: string, nowSec: number): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!isFinite(t) || Math.abs(nowSec - t) > TOLERANCE_S) return false;
  const expected = await signWebhook(secret, body, t);
  // Audit-003 L7: always run the constant-time loop, even on length mismatch.
  // The length of `expected` is deterministic given the secret/hash, so the
  // pre-check leaks only attacker-controlled header length — but the
  // asymmetry is a code smell that the PHP receiver's `hash_equals` avoids.
  return constantTimeEqual(expected, header);
}

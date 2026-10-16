const TOLERANCE_S = 300;

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
 * Constant-time string equality comparison.
 * Avoids early exits on character mismatches to defend against timing attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

export async function verifyWebhook(secret: string, body: string, header: string, nowSec: number): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!isFinite(t) || Math.abs(nowSec - t) > TOLERANCE_S) return false;
  const expected = await signWebhook(secret, body, t);
  return constantTimeEqual(expected, header);
}


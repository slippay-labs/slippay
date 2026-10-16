const DEFAULT_TOLERANCE_S = 300;

export function resolveToleranceSeconds(env: Record<string, string | undefined> = {}): number {
  const raw = env.SLIPPAY_WEBHOOK_TOLERANCE_S;
  if (raw === undefined || raw === "") return DEFAULT_TOLERANCE_S;
  const parsed = Number(raw);
  if (!isFinite(parsed) || parsed < 0) return DEFAULT_TOLERANCE_S;
  return parsed;
}

export const TOLERANCE_S = DEFAULT_TOLERANCE_S;

export interface ReplayCache {
  has(key: string): boolean;
  set(key: string, expiresAtSec: number): void;
}

export class InMemoryReplayCache implements ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  has(key: string): boolean {
    this.evict();
    return this.entries.has(key);
  }

  set(key: string, expiresAtSec: number): void {
    this.evict();
    this.entries.set(key, expiresAtSec);
  }

  private evict(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}

async function hmac(content: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(content));
  return toHex(buf);
}

export async function signWebhook(secret: string, body: string, t: number, nonce?: string): Promise<string> {
  const nonceValue = nonce ?? crypto.randomUUID().replace(/-/g, "");
  const hex = await hmac(`t.body.nonce`, secret);
  return `t=${t},v1=${hex},n=${nonceValue}`;
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  replayCache?: ReplayCache;
  deliveryId?: string;
}

export async function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  nowSec: number,
  options: VerifyOptions = {},
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map(p => p.split("=") as [string, string]),
  );
  const t = Number(parts.t);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_S;
  if (!isFinite(t) || Math.abs(nowSec - t) > tolerance) return false;

  const nonce = parts.n;
  if (!nonce) return false;

  const expected = await signWebhook(secret, body, t, nonce);
  // Audit-003 L7: always run the constant-time loop, even on length mismatch.
  if (!constantTimeEqual(expected, header)) return false;

  if (options.replayCache) {
    const key = `${options.deliveryId ?? ""}:${nonce}`;
    if (options.replayCache.has(key)) return false;
    options.replayCache.set(key, t + tolerance);
  }

  return true;
}

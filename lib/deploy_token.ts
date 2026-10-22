import crypto from "node:crypto";

/**
 * Short-lived, single-use deploy tokens.
 *
 * Tokens are issued by GET /info and verified by POST /v1/relayer/deploy.
 * Each token is bound to a passkey public key and is consumed on first use.
 */

export interface DeployTokenClaims {
  /** Passkey public key the token is bound to (hex). */
  passkeyPubKey: string;
  /** Unix epoch milliseconds at which the token expires. */
  expiresAt: number;
}

export interface DeployToken extends DeployTokenClaims {
  /** Opaque token string to return to the client. */
  token: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "unknown" | "expired" | "mismatch" | "malformed";
}

const TOKEN_TTL_MS = Number(process.env.DEPLOY_TOKEN_TTL_MS ?? "120000"); // 2 minutes
const TOKEN_SECRET =
  process.env.DEPLOY_TOKEN_SECRET ?? crypto.randomBytes(32).toString("hex");

/**
 * In-memory store of consumed tokens. In a multi-instance deployment this
 * should be backed by a shared store (Redis/PG); the interface is kept small so
 * it can be swapped out.
 */
const consumed = new Map<string, number>();

function pruneExpired(now: number): void {
  for (const [key, expiresAt] of consumed) {
    if (expiresAt <= now) {
      consumed.delete(key);
    }
  }
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
}

function encode(claims: DeployTokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function decode(token: string): { claims: DeployTokenClaims; payload: string; sig: string } | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as DeployTokenClaims;
    if (
      typeof claims.passkeyPubKey !== "string" ||
      typeof claims.expiresAt !== "number"
    ) {
      return null;
    }
    return { claims, payload, sig };
  } catch {
    return null;
  }
}

/**
 * Issue a new deploy token bound to a passkey public key.
 */
export function issueDeployToken(passkeyPubKey: string): DeployToken {
  if (typeof passkeyPubKey !== "string" || passkeyPubKey.length === 0) {
    throw new Error("passkeyPubKey is required");
  }
  const now = Date.now();
  pruneExpired(now);
  const claims: DeployTokenClaims = {
    passkeyPubKey: passkeyPubKey.toLowerCase(),
    expiresAt: now + TOKEN_TTL_MS,
  };
  return { token: encode(claims), ...claims };
}

/**
 * Verify and consume a deploy token. The token is bound to the passkey
 * public key supplied in the deploy request; a mismatch is rejected.
 */
export function verifyDeployToken(token: string, passkeyPubKey: string): VerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const decoded = decode(token);
  if (!decoded) {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(decoded.payload);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(decoded.sig);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "malformed" };
  }
  const now = Date.now();
  if (decoded.claims.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  if (decoded.claims.passkeyPubKey !== passkeyPubKey.toLowerCase()) {
    return { ok: false, reason: "mismatch" };
  }
  // Single-use: reject if already consumed.
  if (consumed.has(token)) {
    return { ok: false, reason: "malformed" };
  }
  consumed.set(token, decoded.claims.expiresAt);
  return { ok: true };
}

/** Test hook: clear consumed tokens. */
export function _resetDeployTokensForTest(): void {
  consumed.clear();
}

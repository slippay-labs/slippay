// Per-account exclusivity lease for the Stellar listener (audit-003 · L2).
//
// Each running listener process gets a stable holder_id (uuid). Before
// starting watchAccount(accountId), it tries to acquire the lease in
// `listener_leases`. While alive, it heartbeats by extending `expires_at`.
// On graceful shutdown, it releases (DELETE). On crash, the next pod that
// polls past expires_at takes over via expired-lease takeover.
//
// Failure modes acknowledged:
// - Clock skew between Supabase and pod: TTL is generous (60s default).
// - Pooled connections: the lease is row-based, not session-based, so pool
//   churn doesn't release the lease prematurely.
// - Two pods racing during initial INSERT: Postgres serializes on the PK;
//   one INSERT wins, the other gets a unique-violation and treats that as
//   "lease taken, sleep + retry".

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

const DEFAULT_LEASE_TTL_S = 60;
const DEFAULT_HEARTBEAT_S = 20;

export const HOLDER_ID = process.env.LISTENER_HOLDER_ID ?? randomUUID();

export type LeaseResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; heldBy: string; expiresAt: string };

/**
 * Snapshot of a lease held by this process. Exposed for the health /
 * metrics surface so an operator (and the orchestrator) can see what this
 * listener is currently watching and when the lease expires.
 */
export type HeldLease = {
  accountId: string;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
};

/**
 * Tracker of leases currently held by this process. Used by the health
 * endpoint to report what is watched and to fail the check when a lease
 * has been lost.
 */
const heldLeases = new Map<string, HeldLease>();

export function getHeldLeases(): HeldLease[] {
  return Array.from(heldLeases.values());
}

export function isHoldingLease(accountId: string): boolean {
  return heldLeases.has(accountId);
}

export function getLeaseExpiry(accountId: string): string | null {
  return heldLeases.get(accountId)?.expiresAt ?? null;
}

export function getLeaseHolder(accountId: string): string | null {
  return heldLeases.get(accountId)?.holderId ?? null;
}

export function getHeldLeaseCount(): number {
  return heldLeases.size;
}

export async function acquireLease(
  db: SupabaseClient,
  accountId: string,
  opts: { ttlSeconds?: number; heartbeatSeconds?: number } = {},
): Promise<LeaseResult> {
  const ttl = opts.ttlSeconds ?? DEFAULT_LEASE_TTL_S;
  const heartbeatMs = (opts.heartbeatSeconds ?? DEFAULT_HEARTBEAT_S) * 1000;
  const now = new Date();
  const expires = new Date(now.getTime() + ttl * 1000);

  // Try fresh INSERT first. If a row exists, look at it.
  const ins = await db.from("listener_leases").insert({
    account_id: accountId,
    holder_id: HOLDER_ID,
    acquired_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });

  if (ins.error) {
    const code = (ins.error as { code?: string }).code;
    if (code !== "23505") { // unique_violation — expected race; anything else is fatal
      log("error", "lease_insert_failed", { account_id: accountId, error: ins.error.message });
      return { acquired: false, heldBy: "unknown", expiresAt: "" };
    }
    // Row exists. Try to steal if expired.
    const cur = await db.from("listener_leases")
      .select("holder_id, expires_at")
      .eq("account_id", accountId)
      .maybeSingle();
    if (cur.error || !cur.data) {
      return { acquired: false, heldBy: "unknown", expiresAt: "" };
    }
    const currentExpires = new Date(cur.data.expires_at as string);
    if (currentExpires.getTime() > now.getTime() && cur.data.holder_id !== HOLDER_ID) {
      return { acquired: false, heldBy: cur.data.holder_id as string, expiresAt: cur.data.expires_at as string };
    }
    // Either expired, or it's our own stale lease. Steal/refresh.
    const steal = await db.from("listener_leases")
      .update({ holder_id: HOLDER_ID, acquired_at: now.toISOString(), expires_at: expires.toISOString() })
      .eq("account_id", accountId)
      .lte("expires_at", new Date(now.getTime() - 1).toISOString())
      .select("holder_id").maybeSingle();
    if (steal.error || !steal.data) {
      // Another pod stole it in the same beat. Back off.
      return { acquired: false, heldBy: "raced", expiresAt: "" };
    }
  }

  heldLeases.set(accountId, {
    accountId,
    holderId: HOLDER_ID,
    acquiredAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  });

  let stopped = false;
  const heartbeat = setInterval(async () => {
    if (stopped) return;
    const nextExpires = new Date(Date.now() + ttl * 1000).toISOString();
    const r = await db.from("listener_leases")
      .update({ expires_at: nextExpires })
      .eq("account_id", accountId)
      .eq("holder_id", HOLDER_ID);
    if (r.error) {
      log("warn", "lease_heartbeat_failed", { account_id: accountId, error: r.error.message });
      return;
    }
    // Keep the health snapshot in sync with the extended expiry.
    const held = heldLeases.get(accountId);
    if (held) held.expiresAt = nextExpires;
  }, heartbeatMs);
  // Prevent the heartbeat timer from keeping the process alive after shutdown.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const release = async () => {
    stopped = true;
    clearInterval(heartbeat);
    heldLeases.delete(accountId);
    const r = await db.from("listener_leases")
      .delete()
      .eq("account_id", accountId)
      .eq("holder_id", HOLDER_ID);
    if (r.error) log("warn", "lease_release_failed", { account_id: accountId, error: r.error.message });
  };

  log("info", "lease_acquired", { account_id: accountId, holder_id: HOLDER_ID, ttl_seconds: ttl });
  return { acquired: true, release };
}

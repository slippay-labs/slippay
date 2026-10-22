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

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Self-scheduling chain: the next tick is only armed after the current
  // heartbeat write has settled. This prevents overlapping updates from
  // racing each other and writing an earlier expires_at over a later one.
  const runHeartbeat = async () => {
    if (stopped) return;
    if (inFlight) {
      // Should be unreachable with the chain, but keep the guard as a
      // defense-in-depth and make the condition observable.
      log("warn", "lease_heartbeat_skipped", {
        account_id: accountId,
        reason: "previous_heartbeat_in_flight",
      });
      return;
    }
    inFlight = true;
    try {
      const nextExpires = new Date(Date.now() + ttl * 1000).toISOString();
      // Monotonic write: never shorten an existing lease. Supabase doesn't
      // expose a greatest() expression in the builder, so we read the
      // current value and only apply the update if our proposal is later.
      // The conditional `.lte("expires_at", ...)` makes the compare-and-set
      // atomic on the database side.
      const update = await db.from("listener_leases")
        .update({ expires_at: nextExpires })
        .eq("account_id", accountId)
        .eq("holder_id", HOLDER_ID)
        .lte("expires_at", nextExpires);
      if (update.error) {
        log("warn", "lease_heartbeat_failed", { account_id: accountId, error: update.error.message });
      }
    } catch (err) {
      log("warn", "lease_heartbeat_failed", {
        account_id: accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = false;
      if (!stopped) {
        timer = setTimeout(() => { void runHeartbeat(); }, heartbeatMs);
        // Prevent the heartbeat timer from keeping the process alive after shutdown.
        if (typeof timer.unref === "function") timer.unref();
      }
    }
  };

  timer = setTimeout(() => { void runHeartbeat(); }, heartbeatMs);
  if (typeof timer.unref === "function") timer.unref();

  const release = async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    const r = await db.from("listener_leases")
      .delete()
      .eq("account_id", accountId)
      .eq("holder_id", HOLDER_ID);
    if (r.error) log("warn", "lease_release_failed", { account_id: accountId, error: r.error.message });
  };

  log("info", "lease_acquired", { account_id: accountId, holder_id: HOLDER_ID, ttl_s: ttl });
  return { acquired: true, release };
}

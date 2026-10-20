import { signWebhook } from "./crypto.js";
import { log } from "./log.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeWebhookUrl, validateWebhookUrl, pinnedDispatcher } from "./ssrf.js";

const SCHEDULE = [60, 300, 1800, 7200, 43200, 86400];

// Response body bytes we read+keep (rest is discarded after abort). Audit-003 L13.
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
// Hard ceiling on a single delivery attempt (per-call timeout).
const REQUEST_TIMEOUT_MS = 10_000;

export function nextBackoff(attempt: number): number | null {
  return SCHEDULE[attempt] ?? null;
}

export interface DeliverArgs {
  url: string;
  secret: string;
  deliveryId: string;
  payload: unknown;
  // Dev-only escape hatch (config.allowLocalWebhooks). Defaults false so the
  // SSRF guard is fail-closed on EVERY network. Audit-003 L1.
  allowLocal?: boolean;
}

export interface DeliverResult {
  status: "sent" | "failed";
  code?: number;
  body?: string;
}

export async function deliverOnce(args: DeliverArgs): Promise<DeliverResult> {
  const allowLocal = args.allowLocal ?? false;

  // Always resolve + validate + pin to defeat DNS rebinding (audit-003 L1).
  // When allowLocal is set (dev-only flag) the lightweight path inside
  // validateWebhookUrl skips the blocklist/https/port/local checks so local
  // mock servers (example.com, localhost) work without DNS round-trips.
  const validation = await validateWebhookUrl(args.url, allowLocal);
  if (!validation.safe) {
    return { status: "failed", body: `unsafe_url:${validation.reason}` };
  }
  const dispatcher = pinnedDispatcher(validation.target);

  const body = JSON.stringify(args.payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = await signWebhook(args.secret, body, t);

  try {
    // dispatcher carries the undici Agent we use to pin DNS on mainnet; cast
    // through `any` to bridge the undici v8 / @types/node undici-types skew.
    const fetchOpts: RequestInit & { dispatcher?: any } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slippay-signature": sig,
        "x-slippay-delivery-id": args.deliveryId,
      },
      body,
      // 3xx is not acceptable for a webhook receiver. Following a redirect
      // would also re-resolve DNS without our pinning. Audit-003 L1+L13.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const r = await fetch(args.url, fetchOpts as RequestInit);

    // Treat any 3xx (now visible via manual mode) as failure.
    if (r.status >= 300 && r.status < 400) {
      return { status: "failed", code: r.status, body: "redirect_not_allowed" };
    }

    // Read body with a hard size cap so a slow/malicious endpoint can't stall
    // or OOM the worker (audit-003 L13). Discard remainder.
    const text = await readCappedBody(r, MAX_RESPONSE_BODY_BYTES);
    return { status: r.ok ? "sent" : "failed", code: r.status, body: text.slice(0, 500) };
  } catch (e) {
    return { status: "failed", body: String(e).slice(0, 500) };
  }
}

async function readCappedBody(r: { body: ReadableStream<Uint8Array> | null }, max: number): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // discard remainder; abort the stream
        try { await reader.cancel(); } catch { /* noop */ }
        const take = max - (total - value.byteLength);
        chunks.push(value.subarray(0, Math.max(0, take)));
        break;
      }
      chunks.push(value);
    }
  } catch { /* swallow stream errors; return what we have */ }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.byteLength; }
  return out;
}

// Poll interval when a batch is empty or produced no state change.
export const WEBHOOK_IDLE_POLL_MS = 5_000;
// Minimum wall-clock interval between iterations when work was found and
// progressed. "Found work" is never a reason to skip the sleep: without it a
// batch that cannot transition (silent update failure, filter/write mismatch)
// re-selects the same rows as fast as the DB round-trip allows.
export const WEBHOOK_MIN_INTERVAL_MS = 250;
// Consecutive selections of the same delivery without a state transition
// before it is dead-lettered (circuit breaker, slippay-labs/slippay#242).
export const WEBHOOK_STUCK_FETCH_LIMIT = 3;

export interface WebhookWorkerOptions {
  idlePollMs?: number;
  minIntervalMs?: number;
  stuckFetchLimit?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function startWebhookWorker(
  db: SupabaseClient,
  allowLocal: boolean,
  opts: WebhookWorkerOptions = {},
) {
  const idlePollMs = opts.idlePollMs ?? WEBHOOK_IDLE_POLL_MS;
  const minIntervalMs = opts.minIntervalMs ?? WEBHOOK_MIN_INTERVAL_MS;
  const stuckFetchLimit = opts.stuckFetchLimit ?? WEBHOOK_STUCK_FETCH_LIMIT;
  let stopped = false;
  // delivery id -> consecutive selections with no state transition (#242).
  const stall = new Map<string, number>();

  // Conditional update: only write if the row is still in the status we read.
  // Returns whether the write actually transitioned the row; a silently-failed
  // or zero-row match counts as "no" so the caller can trip the breaker.
  async function guardUpdate(id: string, claimedStatus: string, patch: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await db.from("webhook_deliveries")
      .update(patch)
      .eq("id", id)
      .eq("status", claimedStatus)
      .select("id");
    if (error) {
      log("error", "webhook_update_failed", { id, error: error.message });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  async function processRow(row: any): Promise<boolean> {
    const merchant = row.orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
    if (!merchant?.webhook_url) {
      return guardUpdate(row.id, row.status, { status: "dead", response_body: "no_webhook_url" });
    }
    // Sync pre-flight: cheap URL-shape rejection before DNS cost.
    if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
      return guardUpdate(row.id, row.status, { status: "dead", response_body: "unsafe_url" });
    }

    const result = await deliverOnce({
      url: merchant.webhook_url,
      secret: merchant.webhook_secret!,
      deliveryId: row.id as string,
      payload: row.payload,
      allowLocal,
    });

    const newAttempt = (row.attempt_n as number) + 1;
    if (result.status === "sent") {
      const transitioned = await guardUpdate(row.id, row.status, {
        status: "sent",
        response_code: result.code,
        response_body: result.body,
        attempt_n: newAttempt,
        last_attempt_at: new Date().toISOString(),
      });
      if (transitioned) log("info", "webhook_sent", { id: row.id, code: result.code });
      return transitioned;
    }

    const backoff = nextBackoff(newAttempt - 1);
    const transitioned = await guardUpdate(row.id, row.status, {
      status: backoff === null ? "dead" : "failed",
      response_code: result.code,
      response_body: result.body,
      attempt_n: newAttempt,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: backoff === null
        ? new Date().toISOString()
        : new Date(Date.now() + backoff * 1000).toISOString(),
    });
    if (transitioned) log("warn", "webhook_failed", { id: row.id, attempt: newAttempt, backoff });
    return transitioned;
  }

  async function tick() {
    while (!stopped) {
      const startedAt = Date.now();
      const { data: rows, error } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, orders ( merchants ( webhook_url, webhook_secret, network ) )")
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (error) {
        log("error", "webhook_query_failed", { error: error.message });
        await sleep(idlePollMs);
        continue;
      }

      const batch = rows ?? [];
      if (batch.length === 0) {
        stall.clear();
        await sleep(idlePollMs);
        continue;
      }

      let progressed = false;
      const selected = new Set<string>();
      for (const row of batch) {
        selected.add(row.id as string);
        let transitioned = false;
        try {
          transitioned = await processRow(row);
        } catch (e) {
          log("error", "webhook_row_failed", { id: row.id, error: String(e) });
        }
        if (transitioned) {
          progressed = true;
          stall.delete(row.id as string);
          continue;
        }
        // Same delivery selected again with no state transition: either its
        // writes silently failed or something else owns it. Circuit-breaker:
        // after N stuck selections mark it dead and log loudly (#242).
        const n = (stall.get(row.id as string) ?? 0) + 1;
        if (n >= stuckFetchLimit) {
          const deadLettered = await guardUpdate(row.id, row.status, {
            status: "dead",
            response_body: "stuck_no_transition",
          });
          log("error", "webhook_delivery_stuck_dead", { id: row.id, selections: n, deadLettered });
          stall.delete(row.id as string);
          if (deadLettered) progressed = true;
        } else {
          stall.set(row.id as string, n);
        }
      }
      // Forget rows that dropped out of the selection (they transitioned or
      // someone else did); only rows seen again count toward the breaker.
      for (const id of [...stall.keys()]) {
        if (!selected.has(id)) stall.delete(id);
      }

      if (!progressed) {
        // A full batch produced no state change: back off further so a
        // permanently-stuck fixture cannot out-poll the connection limit.
        await sleep(idlePollMs);
        continue;
      }
      // Always yield, even when work was found.
      const remaining = minIntervalMs - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }
  }

  tick();
  return () => { stopped = true; };
}

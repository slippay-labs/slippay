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

export const TERMINAL_NEXT_ATTEMPT_AT = "9999-12-31T23:59:59.999Z";
export const MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Classifies whether an HTTP response status represents a permanent failure
 * that should dead-letter immediately rather than consuming the backoff schedule.
 * 4xx codes (Client Errors) are considered permanent, EXCEPT 429 Too Many Requests,
 * which should be retried per standard backoff.
 */
export function isPermanentFailure(code?: number): boolean {
  if (typeof code !== "number") return false;
  return code >= 400 && code < 500 && code !== 429;
}

/**
 * Checks if a delivery row exceeds the maximum permissible delivery age
 * based on order expiration or row creation.
 */
export function isDeliveryExpired(
  order?: { expires_at?: string; created_at?: string },
  nowMs = Date.now(),
  maxAgeMs = MAX_DELIVERY_AGE_MS
): boolean {
  if (!order) return false;
  if (order.expires_at) {
    const expiresMs = new Date(order.expires_at).getTime();
    if (!isNaN(expiresMs) && nowMs > expiresMs + maxAgeMs) {
      return true;
    }
  }
  if (order.created_at) {
    const createdMs = new Date(order.created_at).getTime();
    if (!isNaN(createdMs) && nowMs > createdMs + maxAgeMs) {
      return true;
    }
  }
  return false;
}

export async function processDeliveryRow(db: SupabaseClient, row: any, allowLocal: boolean) {
  const order = (row as any).orders as { expires_at?: string; created_at?: string; merchants?: { webhook_url?: string; webhook_secret?: string; network?: string } };
  
  if (isDeliveryExpired(order)) {
    await db.from("webhook_deliveries").update({
      status: "dead",
      response_body: "delivery_expired_max_age",
      next_attempt_at: TERMINAL_NEXT_ATTEMPT_AT,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", row.id);
    log("warn", "webhook_dead_lettered", { id: row.id, reason: "delivery_expired_max_age" });
    return;
  }

  const merchant = order?.merchants;
  if (!merchant?.webhook_url) {
    await db.from("webhook_deliveries").update({
      status: "dead",
      response_body: "no_webhook_url",
      next_attempt_at: TERMINAL_NEXT_ATTEMPT_AT,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", row.id);
    return;
  }

  // Sync pre-flight: cheap URL-shape rejection before DNS cost.
  if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
    await db.from("webhook_deliveries").update({
      status: "dead",
      response_body: "unsafe_url",
      next_attempt_at: TERMINAL_NEXT_ATTEMPT_AT,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", row.id);
    return;
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
    await db.from("webhook_deliveries").update({
      status: "sent",
      response_code: result.code,
      response_body: result.body,
      attempt_n: newAttempt,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", row.id);
    log("info", "webhook_sent", { id: row.id, code: result.code });
  } else {
    // Classify failure:
    // 1. Permanent failure (4xx other than 429) -> dead-letter immediately!
    // 2. Retryable failure (5xx, 429, transport errors) -> schedule next backoff
    const permanent = isPermanentFailure(result.code);
    const backoff = permanent ? null : nextBackoff(newAttempt - 1);
    const isDead = permanent || backoff === null;

    const terminalReason = permanent
      ? `permanent_client_error_${result.code}`
      : (backoff === null ? "attempts_exhausted" : undefined);

    await db.from("webhook_deliveries").update({
      status: isDead ? "dead" : "failed",
      response_code: result.code,
      response_body: terminalReason ? `${terminalReason}: ${result.body ?? ""}`.slice(0, 500) : result.body,
      attempt_n: newAttempt,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: isDead
        ? TERMINAL_NEXT_ATTEMPT_AT
        : new Date(Date.now() + (backoff ?? 0) * 1000).toISOString(),
    }).eq("id", row.id);

    if (isDead) {
      log("warn", "webhook_dead_lettered", { id: row.id, attempt: newAttempt, code: result.code, reason: terminalReason });
    } else {
      log("warn", "webhook_failed", { id: row.id, attempt: newAttempt, code: result.code, backoff });
    }
  }
}

export function startWebhookWorker(db: SupabaseClient, allowLocal: boolean) {
  let stopped = false;

  async function tick() {
    while (!stopped) {
      const { data: rows } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, orders ( expires_at, created_at, merchants ( webhook_url, webhook_secret, network ) )")
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (!rows || rows.length === 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const row of rows) {
        await processDeliveryRow(db, row, allowLocal);
      }
    }
  }

  tick();
  return () => { stopped = true; };
}

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

export interface WebhookWorkerOptions {
  minIntervalMs?: number;
  idleIntervalMs?: number;
  stuckThreshold?: number;
}

export function startWebhookWorker(
  db: SupabaseClient,
  allowLocal: boolean,
  options: WebhookWorkerOptions = {}
) {
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const idleIntervalMs = options.idleIntervalMs ?? 5000;
  const stuckThreshold = options.stuckThreshold ?? 5;

  let stopped = false;
  const stuckCounts = new Map<string, number>();

  async function tick() {
    while (!stopped) {
      const { data: rows, error: selectErr } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, orders ( merchants ( webhook_url, webhook_secret, network ) )")
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (selectErr || !rows || rows.length === 0) {
        if (selectErr) {
          log("error", "webhook_select_failed", { error: selectErr.message });
        }
        await new Promise(r => setTimeout(r, idleIntervalMs));
        continue;
      }

      let stateChanges = 0;
      const currentSelectedIds = new Set(rows.map(r => r.id as string));
      // Evict deliveries that have transitioned out of the polling set
      for (const id of stuckCounts.keys()) {
        if (!currentSelectedIds.has(id)) {
          stuckCounts.delete(id);
        }
      }

      for (const row of rows) {
        if (stopped) break;
        const currentCount = (stuckCounts.get(row.id) ?? 0) + 1;
        stuckCounts.set(row.id, currentCount);

        // Circuit breaker: if the same delivery ID is selected stuckThreshold times
        // without an exiting state transition, dead-letter it loudly.
        if (currentCount >= stuckThreshold) {
          log("error", "webhook_circuit_breaker_triggered", {
            id: row.id,
            stuck_iterations: currentCount,
            reason: "exceeded_stuck_threshold_without_transition",
          });
          await db.from("webhook_deliveries").update({
            status: "dead",
            response_body: "circuit_breaker_stuck_threshold_exceeded",
            next_attempt_at: "9999-12-31T23:59:59.999Z",
            last_attempt_at: new Date().toISOString(),
          }).eq("id", row.id);
          stuckCounts.delete(row.id);
          stateChanges++;
          continue;
        }

        const merchant = (row as any).orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
        if (!merchant?.webhook_url) {
          await db.from("webhook_deliveries").update({
            status: "dead",
            response_body: "no_webhook_url",
            next_attempt_at: "9999-12-31T23:59:59.999Z",
            last_attempt_at: new Date().toISOString(),
          }).eq("id", row.id);
          stateChanges++;
          continue;
        }

        // Sync pre-flight: cheap URL-shape rejection before DNS cost.
        if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
          await db.from("webhook_deliveries").update({
            status: "dead",
            response_body: "unsafe_url",
            next_attempt_at: "9999-12-31T23:59:59.999Z",
            last_attempt_at: new Date().toISOString(),
          }).eq("id", row.id);
          stateChanges++;
          continue;
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
          stateChanges++;
        } else {
          const backoff = nextBackoff(newAttempt - 1);
          await db.from("webhook_deliveries").update({
            status: backoff === null ? "dead" : "failed",
            response_code: result.code,
            response_body: result.body,
            attempt_n: newAttempt,
            last_attempt_at: new Date().toISOString(),
            next_attempt_at: backoff === null
              ? "9999-12-31T23:59:59.999Z"
              : new Date(Date.now() + backoff * 1000).toISOString(),
          }).eq("id", row.id);
          log("warn", "webhook_failed", { id: row.id, attempt: newAttempt, backoff });
          stateChanges++;
        }
      }

      // Always yield after processing a batch:
      // If a batch produced no state changes, back off with idleIntervalMs.
      // Otherwise yield the minimum interval to prevent tight-loop spinning.
      const sleepDuration = stateChanges === 0 ? idleIntervalMs : minIntervalMs;
      await new Promise(r => setTimeout(r, sleepDuration));
    }
  }

  tick();
  return () => { stopped = true; };
}

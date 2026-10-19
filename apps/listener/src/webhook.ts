import { signWebhook } from "./crypto.js";
import { log } from "./log.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeWebhookUrl, validateWebhookUrl, pinnedDispatcher } from "./ssrf.js";

const SCHEDUL = [60, 300, 1800, 7200, 43200, 86400];

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

// Runs a Supabase query and surfaces its error channel. Every DB interaction
// in the worker goes through here so a failed write is never silently swallowed.
// Returns true on success, false when the call failed.
async function runQuery<T>(
  op: string,
  deliveryId: string,
  query: PromiseLike<Result<T>>,
): Promise<boolean> {
  try {
    const { error } = await query;
    if (error) {
      log("error", "webhook_db_error", { id: deliveryId, op, error: error.message ?? String(error) });
      return false;
    }
    return true;
  } catch (e) {
    log("error", "webhook_db_error", { id: deliveryId, op, error: String(e) });
    return false;
  }
}

export function startWebhookWorker(db: SupabaseClient, allowLocal: boolean) {
  let stopped = false;

  async function tick() {
    while (!stopped) {
      const selectResult = await db["from"] ? null : null; // type narrowing only; unused
      void selectResult;
      const { data: rows, error: selectError } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, orders ( merchants ( webhook_url, webhook_secret, network ) )")
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (selectError) {
        log("error", "webhook_db_error", { op: "select_due", error: selectError.message ?? String(selectError) });
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (!rows || rows.length === 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const row of rows) {
        const id = row.id as string;
        const merchant = (row as any).orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
        if (!merchant?.webhook_url) {
          // On failure the row stays queued/failed and is retried next tick.
          await runQuery(
            "mark_dead_no_url",
            id,
            db.from("webhook_deliveries").update({ status: "dead", response_body: "no_webhook_url" }).eq("id", id),
          );
          continue;
        }
        // Sync pre-flight: cheap URL-shape rejection before DNS cost.
        if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
          await runQuery(
            "mark_dead_unsafe_url",
            id,
            db.from("webhook_deliveries").update({ status: "dead", response_body: "unsafe_url" }).eq("id", id),
          );
          continue;
        }

        const result = await deliverOnce({
          url: merchant.webhook_url,
          secret: merchant.webhook_secret!,
          deliveryId: id,
          payload: row.payload,
          allowLocal,
        });

        const newAttempt = (row.attempt_n as number) + 1;
        if (result.status === "sent") {
          const ok = await runQuery(
            "mark_sent",
            id,
            db.from("webhook_deliveries").update({
              status: "sent",
              response_code: result.code,
              response_body: result.body,
              attempt_n: newAttempt,
              last_attempt_at: new Date().toISOString(),
            }).eq("id", id),
          );
          if (ok) {
            log("info", "webhook_sent", { id, code: result.code });
          } else {
            // Status write failed: the row remains queued/failed and will be
            // retried on the next tick. Surface it explicitly.
            log("warn", "webhook_status_write_failed", { id: row.id, status: "sent" });
          }
        } else {
          const backoff = nextBackoff(newAttempt - 1);
          const ok = await runQuery(
            "mark_failed",
            id,
            db.from("webhook_deliveries").update({
              status: backoff === null ? "dead" : "failed",
              response_code: result.code,
              response_body: result.body,
              attempt_n: newAttempt,
              last_attempt_at: new Date().toISOString(),
              next_attempt_at: backoff === null
                ? new Date().toISOString()
                : new Date(Date.now() + backoff * 1000).toISOString(),
            }).eq("id", id),
          );
          if (ok) {
            log("warn", "webhook_failed", { id, attempt: newAttempt, backoff });
          } else {
            log("warn", "webhook_status_write_failed", { id: row.id, status: backoff === null ? "dead" : "failed" });
          }
        }
      }
    }
  }

  tick();
  return () => { stopped = true; };
}

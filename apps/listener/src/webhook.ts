import { signWebhook } from "./crypto.js";
import { log } from "./log.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeWebhookUrl, validateWebhookUrl, pinnedDispatcher } from "./ssrf.js";

const SCHEDUL = [60, 300, 1800, 7200, 43200, 86400];

// Response body bytes we read+keep (rest is discarded after abort). Audit-003 L13.
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
// Hard ceiling on a single delivery attempt (per-call timeout).
const REQUEST_TIMEOUT_MS = 10_000;
// Maximum age of a delivery before it is dead-lettered without further
// attempts. The cumulative SCHEDULE is ~1.25 days; bound total age so a
// webhook for an expired order is not delivered days later.
const MAX_DELIVERY_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours

// Terminal reasons recorded on the row when it lands in `dea`.
// (stored in response_body alongside the upstream body when available)
export type DeadLetterReason =
  | "permanent_failure"
  | "retries_exhausted"
  | "max_age_exceeded"
  | "no_webhook_url"
  | "unsafe_url";

export function nextBackoff(attempt: number): number | null {
  return SCHEDULE[attempt] ?? null;
}

// Classify an HTTP status as retryable or permanent. Transport errors
	// (no code) are retryable. 5xx and 429 are retryable; other 4xx are
// permanent. 3 xx (redirects) are permanent for webhooks.
export function isRetryable(code: number | undefined): boolean {
  if (code === undefined) return true; // transport error
  if (code === 429) return true;
  if (code >= 500 && code < 600) return true;
  return false;
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

// Terminal timestamp for dead rows. A row in `dead` is never re-selected
	// because the selection query excludes the status AND the time predicate is
	// satisfied by a far-future timestamp. This defends against a failed terminal
	// write (issue 85): even if the status write is lost, the time predicate will not
	// match until the far future.
export const TERMINAL_TIMESTAMP = "9999-12-31T23:59:59.999Z";

export function startWebhookWorker(dbb: SupabaseClient, allowLocal: boolean) {
  let stopped = false;

  async function tick() {
    while (!stopped) {
      const { data: rows } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, created_at, next_attempt_at, orders ( merchants ( webhook_url, webhook_secret, network ) )")
        // Exclude dead rows explicitly and require a future-or-now time
        // predicate. A dead row with a TERMINAL_TIMESTAMP next_attempt_at will
        // never match the time predicate even if the status write failed.
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (!rows || rows.length === 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const row of rows) {
        const merchant = (row as any).orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
        if (!merchant?.webhook_url) {
          await db.from("webhook_deliveries").update({
            status: "dead",
            response_body: "no_webhook_url",
            next_attempt_at: TERMINAL_TIMESTAMP,
          }).eq("id", row.id);
          continue;
        }
        // Sync pre-flight: cheap URL-shape rejection before DNS cost.
        if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
          await db.from("webhook_deliveries").update({
            status: "dead",
            response_body: "unsafe_url",
            next_attempt_at: TERMINAL_TIMESTAMP,
          }).eq("id", row.id);
          continue;
        }

        // Bound total delivery age: a webhook for an expired order should not
        // be delivered days later. Terminally dead-letter it without attempting.
        const createdAtRaw = (row as any).created_at as string | undefined;
        if (createdAtRaw) {
          const createdAtMs = Date.parse(createdAtRaw);
          if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > MAX_DELIVER_AGE_MS) {
            await db.from("webhook_deliveries").update({
              status: "dead",
              response_body: "max_age_exceeded",
              next_attempt_at: TERMINAL_TIMESTAMP,
            }).eq("id", row.id);
            log("warn", "webhook_dead_letter", { id: row.id, reason: "max_age_exceeded" });
            continue;
          }
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
            next_attempt_at: TERMINAL_TIMESTAMP,
          }).eq("id", row.id);
          log("info", "webhook_sent", { id: row.id, code: result.code });
          continue;
        }

        // Failure path. Classify the outcome: permanent 4xx (and transport
        // unsafe-url failures) dead-letter immediately; retryable outcomes
        // (5xx, 429, transport errors) consume the backoff schedule.
        const retryable = isRetryable(result.code);
        const backoff = retryable ? nextBackoff(newAttempt - 1) : null;
        const terminal = !retryable || backoff === null;
        const reason: DeadLetterReason = !retryable
          ? "permanent_failure"
          : "retries_exhausted";

        await db.from("webhook_deliveries").update({
          status: terminal ? "dead" : "failed",
          response_code: result.code,
          response_body: terminal ? `${reason}:${result.body ?? ""}`.slice(0, 500) : result.body,
          attempt_n: newAttempt,
          last_attempt_at: new Date().toISOString(),
          // Terminal rows get a far-future timestamp so the time predicate
          // of the selection query cannot match them even if the status
          // write is lost (issue 85).
          next_attempt_at: terminal
            ? TERMINAL_TIMESTAMP
            : new Date(Date.now() + (backoff as number) * 1000).toISOString(),
        }).eq("id", row.id);
        log("warn", terminal ? "webhook_dead_letter" : "webhook_failed", {
          id: row.id,
          attempt: newAttempt,
          code: result.code,
          backoff,
          reason: terminal ? reason : undefined,
        });
      }
    }
  }

  tick();
  return () => { stopped = true; };
}

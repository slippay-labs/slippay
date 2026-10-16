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

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_PER_HOST_CONCURRENCY = 2;

export interface WebhookWorkerOpts {
  concurrency?: number;
  perHostConcurrency?: number;
  pollIntervalMs?: number;
}

function getHost(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

async function processSingleDelivery(row: any, allowLocal: boolean, db: SupabaseClient): Promise<void> {
  const merchant = (row as any).orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
  if (!merchant?.webhook_url) {
    await db.from("webhook_deliveries").update({
      status: "dead",
      response_body: "no_webhook_url",
      duration_ms: 0,
    }).eq("id", row.id);
    return;
  }

  // Sync pre-flight: cheap URL-shape rejection before DNS cost.
  if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
    await db.from("webhook_deliveries").update({
      status: "dead",
      response_body: "unsafe_url",
      duration_ms: 0,
    }).eq("id", row.id);
    return;
  }

  const startMs = Date.now();
  const result = await deliverOnce({
    url: merchant.webhook_url,
    secret: merchant.webhook_secret!,
    deliveryId: row.id as string,
    payload: row.payload,
    allowLocal,
  });
  const durationMs = Date.now() - startMs;

  const newAttempt = (row.attempt_n as number) + 1;
  if (result.status === "sent") {
    await db.from("webhook_deliveries").update({
      status: "sent",
      response_code: result.code,
      response_body: result.body,
      attempt_n: newAttempt,
      duration_ms: durationMs,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", row.id);
    log("info", "webhook_sent", { id: row.id, code: result.code, duration_ms: durationMs });
  } else {
    const backoff = nextBackoff(newAttempt - 1);
    await db.from("webhook_deliveries").update({
      status: backoff === null ? "dead" : "failed",
      response_code: result.code,
      response_body: result.body,
      attempt_n: newAttempt,
      duration_ms: durationMs,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: backoff === null
        ? new Date().toISOString()
        : new Date(Date.now() + backoff * 1000).toISOString(),
    }).eq("id", row.id);
    log("warn", "webhook_failed", { id: row.id, attempt: newAttempt, backoff, duration_ms: durationMs });
  }
}

export async function deliverBatchWithConcurrency(
  rows: any[],
  allowLocal: boolean,
  db: SupabaseClient,
  opts: { concurrency?: number; perHostConcurrency?: number } = {},
): Promise<void> {
  const maxConcurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPerHost = opts.perHostConcurrency ?? DEFAULT_PER_HOST_CONCURRENCY;

  const inFlightPerHost = new Map<string, number>();
  let inFlightTotal = 0;
  const pending = [...rows];

  return new Promise<void>((resolve) => {
    if (pending.length === 0) {
      resolve();
      return;
    }

    function tryDispatchNext() {
      if (pending.length === 0 && inFlightTotal === 0) {
        resolve();
        return;
      }

      for (let i = 0; i < pending.length; i++) {
        if (inFlightTotal >= maxConcurrency) {
          break; // Global concurrency limit reached
        }

        const candidate = pending[i];
        const merchant = candidate.orders?.merchants as { webhook_url?: string } | undefined;
        const host = merchant?.webhook_url ? getHost(merchant.webhook_url) : "unknown";
        const currentHostCount = inFlightPerHost.get(host) ?? 0;

        if (currentHostCount >= maxPerHost) {
          // Per-host concurrency cap reached for this host; skip to next candidate
          continue;
        }

        // Dispatch candidate i
        pending.splice(i, 1);
        i--;

        inFlightTotal++;
        inFlightPerHost.set(host, currentHostCount + 1);

        processSingleDelivery(candidate, allowLocal, db)
          .catch((err) => {
            log("error", "webhook_delivery_unhandled_error", { id: candidate.id, error: String(err) });
          })
          .finally(() => {
            inFlightTotal--;
            const count = inFlightPerHost.get(host) ?? 1;
            if (count <= 1) {
              inFlightPerHost.delete(host);
            } else {
              inFlightPerHost.set(host, count - 1);
            }
            tryDispatchNext();
          });
      }
    }

    tryDispatchNext();
  });
}

export async function processWebhookBatch(
  db: SupabaseClient,
  allowLocal: boolean,
  opts: WebhookWorkerOpts = {},
): Promise<number> {
  const { data: rows } = await db.from("webhook_deliveries")
    .select("id, order_id, payload, attempt_n, status, orders ( merchants ( webhook_url, webhook_secret, network ) )")
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(50);

  if (!rows || rows.length === 0) {
    return 0;
  }

  await deliverBatchWithConcurrency(rows, allowLocal, db, opts);
  return rows.length;
}

export function startWebhookWorker(db: SupabaseClient, allowLocal: boolean, opts: WebhookWorkerOpts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function loop() {
    if (stopped) return;
    try {
      await processWebhookBatch(db, allowLocal, opts);
    } catch (e) {
      log("error", "webhook_worker_error", { error: String(e) });
    }
    if (!stopped) {
      timer = setTimeout(loop, pollIntervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }
  }

  loop();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

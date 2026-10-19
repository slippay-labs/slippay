import { signWebhook } from "./crypto.js";
import { log } from "./log.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeWebhookUrl, validateWebhookUrl, pinnedDispatcher } from "./ssrf.js";

const SCHEDUL = [60, 300, 1800, 7200, 43200, 86400];

// Response body bytes we read+keep (rest is discarded after abort). Audit-003 L13.
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
// Hard ceiling on a single delivery attempt (per-call timeout).
const REQUEST_TIMEOUT_MS = 10_000;
// Maximum number of deliveries in flight at once across the whole batch.
// Bounds worker occupancy so one slow receiver cannot block the batch.
const DELIVERY_CONCURRENCY = 8;
// Maximum number of in-flight deliveries to a single host, so one
// receiver cannot consume the whole pool.
const PER_HOST_CONCURRENCY = 2;

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
  // Wall-clock duration of this attempt in milliseconds, so slow
  // receivers are identifiable. Acceptance criteria: attempt durations
  // are recorded per delivery.
  durationMs?: number;
}

export async function deliverOnce(args: DeliverArgs): Promise<DeliverResult> {
  const startedAt = Date.now();
  const allowLocal = args.allowLocal ?? false;

  // Always resolve + validate + pin to defeat DNS rebinding (audit-003 L1).
  // When allowLocal is set (dev-only flag) the lightweight path inside
  // validateWebhookUrl skips the blocklist/https/port/local checks so local
  // mock servers (example.com, localhost) work without DNS round-trips.
  const validation = await validateWebhookUrl(args.url, allowLocal);
  if (!validation.safe) {
    return { status: "failed", body: `unsafe_url:${validation.reason}`, durationMs: Date.now() - startedAt };
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
      // 33x is not acceptable for a webhook receiver. Following a redirect
      // would also re-resolve DNS without our pinning. Audit-003 L1+L13.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const r = await fetch(args.url, fetchOpts as RequestInit);

    // Treat any 3xx (now visible via manual mode) as failure.
    if (r.status >= 300 && r.status < 400) {
      return { status: "failed", code: r.status, body: "redirect_not_allowed", durationMs: Date.now() - startedAt };
    }

    // Read body with a hard size cap so a slow/malicious endpoint can't stall
    // or OOM the worker (audit-003 L13). Discard remainder.
    const text = await readCappedBody(r, MAX_RESPONSE_BODY_BYTES);
    return { status: r.ok ? "sent" : "failed", code: r.status, body: text.slice(0, 500), durationMs: Date.now() - startedAt };
  } catch (e) {
    return { status: "failed", body: String(e).slice(0, 500), durationMs: Date.now() - startedAt };
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

/**
 * Run `tasks` with at most `limit` concurrent invocations. Results are
 * returned in input order. Errors from individual tasks propagate (the
 * worker pool still drains remaining tasks first).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("mapWithConcurrency: limit must be >= 1");
  const output = new Array<R>(items.length);
  let next = 0;
  let firstErr: unknown = undefined;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        output[i] = await fn(items[i], i);
      } catch (e) {
        if (firstErr === undefined) firstErr = e;
      }
    }
  });
  await Promise.all(workers);
  if (firstErr !== undefined) throw firstErr;
  return output;
}

/**
 * A simple counting semaphore keyed by host. Used to cap in-flight
 * deliveries to a single receiver so one slow host cannot consume the
 * whole worker pool.
 */
export class HostSemaphore {
  private readonly limit: number;
  private readonly in = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(limit: number) {
    if (limit < 1) throw new Error("HostSemaphore: limit must be >= 1");
    this.limit = limit;
  }

  async acquire(host: string): Promise<void> {
    const cur = this.in.get(host) ?? 0;
    if (cur < this.limit) {
      this.in.set(host, cur + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(host) ?? [];
      q.push(resolve);
      this.waiters.set(host, q);
    });
  }

  release(host: string): void {
    const q = this.waiters.get(host);
    if (q && q.length > 0) {
      // Hand the slot directly to the next waiter; the count stays the same.
      const next = q.shift()!;
      if (q.length === 0) this.waiters.delete(host);
      next();
      return;
    }
    const cur = this.in.get(host) ?? 0;
    if (cur <= 1) this.in.delete(host);
    else this.in.set(host, cur - 1);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ProcessBatchOptions {
  // Max in-flight deliveries across the batch. Defaults to DELIVERY_CONCURRENCY.
  concurrency?: number;
  // Max in-flight deliveries to a single host. Defaults to PER_HOST_CONCURRENCY.
  perHostConcurrency?: number;
  // How to derive the host key for an item. Defaults to treating the item as a
 // webhook URL string.
  hostOf?: (item: any) => string;
}

/**
 * Process a batch of deliveries with a bounded worker pool and a
 * per-host concurrency cap. Each handler result is augmented with a
 * durationMs field recording the attempt wall-clock duration.
 */
export async function processBatch<T>(
  items: T[],
  handler: (item: T, index: number) => Promise<{ status: "sent" | "failed"; code?: number; body?: string; durationMs?: number }>,
  opts: ProcessBatchOptions = {},
): Promise<Array<{ status: "sent" | "failed"; code?: number; body?: string; durationMs?: number }>> {
  const concurrency = opts.concurrency ?? DELIVERY_CONCURRENCY;
  const perHostConcurrency = opts.perHostConcurrency ?? PER_HOST_CONCURRENCY;
  const hostKey = opts.hostOf ?? ((item: any) => hostOf(String(item)));
  const hostSem = new HostSemaphore(perHostConcurrency);

  return mapWithConcurrency(items, concurrency, async (item, index) => {
    const host = hostKey(item);
    await hostSem.acquire(host);
    const started = Date.now();
    try {
      const result = await handler(item, index);
      return { ...result, durationMs: result.durationMs ?? Date.now() - started };
    } finally {
      hostSem.release(host);
    }
  });
}

export interface WebhookWorkerOptions {
  // Max in-flight deliveries across the batch. Defaults to DELIVERY_CONCURRENCY.
  concurrency?: number;
  // Max in-flight deliveries to a single host. Defaults to PER_HOST_CONCURRENCY.
  perHostConcurrency?: number;
}

export function startWebhookWorker(dbb: SupabaseClient, allowLocal: boolean, opts: WebhookWorkerOptions = {}) {
  let stopped = false;
  const concurrency = opts.concurrency ?? DELIVERY_CONCURRENCY;
  const perHostConcurrency = opts.perHostConcurrency ?? PER_HOST_CONCURRENCY;

  async function processRow(row: any): Promise<void> {
    const merchant = row.orders?.merchants as { webhook_url?: string; webhook_secret?: string; network?: string };
    if (!merchant?.webhook_url) {
      await db.from("webhook_deliveries").update({ status: "dead", response_body: "no_webhook_url" }).eq("id", row.id);
      return;
    }
    // Sync pre-flight: cheap URL-shape rejection before DNS cost.
    if (!isSafeWebhookUrl(merchant.webhook_url, allowLocal)) {
      await db.from("webhook_deliveries").update({ status: "dead", response_body: "unsafe_url" }).eq("id", row.id);
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
        duration_ms: result.durationMs,
      }).eq("id", row.id);
      log("info", "webhook_sent", { id: row.id, code: result.code, duration_ms: result.durationMs });
    } else {
      const backoff = nextBackoff(newAttempt - 1);
      await db.from("webhook_deliveries").update({
        status: backoff === null ? "dead" : "failed",
        response_code: result.code,
        response_body: result.body,
        attempt_n: newAttempt,
        last_attempt_at: new Date().toISOString(),
        duration_ms: result.durationMs,
        next_attempt_at: backoff === null
          ? new Date().toISOString()
          : new Date(Date.now() + backoff * 1000).toISOString(),
      }).eq("id", row.id);
      log("warn", "webhook_failed", { id: row.id, attempt: newAttempt, backoff, duration_ms: result.durationMs });
    }
  }

  async function tick() {
    while (!stopped) {
      const { data: rows } = await db.from("webhook_deliveries")
        .select("id, order_id, payload, attempt_n, status, orders ( merchants ( webhook_url, webhook_secret, network ) )")
        .in("status", ["queued", "failed"])
        .lte("next_attempt_at", new Date().toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(50);

      if (!rows || rows.length === 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Bounded worker pool: at most `concurrency` deliveries in flight,
      // so one slow receiver cannot block the rest of the batch.
      await mapWithConcurrency(rows, concurrency, async (row) => {
        if (stopped) return;
        try {
          await processRow(row);
        } catch (e) {
          log("warn", "webhook_row_error", { id: (row as any).id, err: String(e) });
        }
      });
    }
  }

  tick();
  return () => { stopped = true; };
}

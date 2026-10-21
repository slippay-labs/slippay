import type { SupabaseClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "./log.js";
import { config } from "./config.js";
import { HOLDER_ID } from "./lease.js";

// -------------------------------------------------------------------------
// Shared listener state registry.
//
// The manager and webhook worker write here as they run so the health
// endpoint can report what the process is actually doing without re-querying
// the database for everything. The delivery counts are queried live from
// Supabase because they are the source of truth and must reflect rows written
// by other pods too.
// ------------------------------------------------------------------------

export interface AccountState {
  // Wallet address this listener is streaming.
  address: string;
  // When the lease we acquired for this account expires (ISO timestamp).
  // Refreshed on every manager tick while the watch is alive.
  leaseExpiresAt: string;
  // True while watchAccount() is running for this account.
  watching: boolean;
  // Last time the manager confirmed this account was still desired and
// the Horizon stream was active (INO timestamp). This is the closest
  // signal we have to "Horizon was last polled successfully" without touching
  // horizon.ts.
  lastPollAt: string;
}

class ListenerState {
  // Accounts the manager believes should be watched (active merchants on
  // this network). Used to detect the silent-loss case: desired but not
  // watched => unhealthy.
  private desired = new Set<string>();
  private accounts = new Map<string, AccountState>();
  // Webhook deliveries currently being processed in-process (across all
  // ticks). Used for the in-flight metric.
  private inFlight = 0;
  // Set true once the manager has completed at least one tick. Before that
  // the process is still coming up and shouldn't be considered dead yet.
  private ready = false;
  // Last time the manager tick completed successfully (ISO timestamp).
  private lastTickAt: string | null = null;

  setDesired(addresses: string[]): void {
    this.desired = new Set(addresses);
  }

  markWatching(address: string, leaseExpiresAt: string): void {
    const existing = this.accounts.get(address);
    this.accounts.set(address, {
      address,
      leaseExpiresAt,
      watching: true,
      lastPollAt: existing?.lastPollAt ?? new Date().toISOString(),
    });
  }

  // Refresh the lease expiry and last-poll timestamp for an already-watched
  // account. Called on every manager tick while the watch is alive.
  touchPoll(address: string, leaseExpiresAt: string): void {
    const existing = this.accounts.get(address);
    if (!existing) return;
    this.accounts.set(address, {
      ...existing,
      leaseExpiresAt,
      watching: true,
      lastPollAt: new Date().toISOString(),
    });
  }

  unmarkWatching(address: string): void {
    this.accounts.delete(address);
  }

  markTickComplete(): void {
    this.ready = true;
    this.lastTickAt = new Date().toISOString();
  }

  setInFlight(n: number): void {
    this.inFlight = n;
  }

  snapshot() {
    return {
      ready: this.ready,
      lastTickAt: this.lastTickAt,
      inFlight: this.inFlight,
      desired: [...this.desired],
      accounts: [...this.accounts.values()],
    };
  }
}

export const listenerState = new ListenerState();

// ------------------------------------------------------------------------
// Health check logic
// ------------------------------------------------------------------------

export interface HealthReport {
  ok: boolean;
  network: string;
  holderId: string;
  ready: boolean;
  lastTickAt: string | null;
  // Accounts the manager wants to watch but is not currently watching.
  // Non-empty => unhealthy (silent-loss case).
  missingLeases: string[];
  // Accounts whose lease expired but the watch is still registered.
  expiredLeases: string[];
  accounts: Array<{
    address: string;
    watching: boolean;
    leaseExpiresAt: string;
    lastPollAt: string;
  }>;
  deliveries: {
    queued: number;
    inFlight: number;
    dead: number;
  };
}

export async function buildHealthReport(db: SupabaseClient): Promise<HealthReport> {
  const snap = listenerState.snapshot();
  const now = Date.now();

  const accounts = snap.accounts.map((a) => ({
    address: a.address,
    watching: a.watching,
    leaseExpiresAt: a.leaseExpiresAt,
    lastPollAt: a.lastPollAt,
  }));

  const watched = new Set(snap.accounts.filter((a) => a.watching).map((a) => a.address));
  const missingLeases = snap.desired.filter((a) => !watched.has(a));
  const expiredLeases = snap.accounts
    .filter((a) => a.watching && new Date(a.leaseExpiresAt).getTime() < now)
    .map((a) => a.address);

  // Live delivery counts from the source of truth. Fail soft: if the count
  // query fails we report zeroes but don't fail the whole health check on a
  // transient DB wrinkle -- the lease/watch checks are the hard failures.
  const deliveries = { queued: 0, inFlight: snap.inFlight, dead: 0 };
  try {
    const { data, error } = await db.from("webhook_deliveries")
      .select("status")
      .in("status", ["queued", "failed", "dead"]);
    if (!error && data) {
      for (const row of data as Array<{ status: string }>) {
        if (row.status === "queued" || row.status === "failed") deliveries.queued++;
        else if (row.status === "dead") deliveries.dead++;
      }
    }
  } catch (e) {
    log("warn", "health_delivery_count_failed", { error: String(e) });
  }

  // Healthy only if: the manager has run at least once, every desired
  // account is being watched, and no lease has expired under a live watch.
  const ok = snap.ready && missingLeases.length === 0 && expiredLeases.length === 0;

  return {
    ok,
    network: config.network,
    holderId: HOLDER_ID,
    ready: snap.ready,
    lastTickAt: snap.lastTickAt,
    missingLeases,
    expiredLeases,
    accounts,
    deliveries,
  };
}

// ------------------------------------------------------------------------
// Prometheus metrics formatter
// ------------------------------------------------------------------------

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metric(name: string, type: "gauge" | "counter", help: string, samples: Array<{ labels?: Record<string, string>; value: number }>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labels = s.labels && Object.keys(s.labels).length > 0
      ? "{" + Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}"
      : "";
    lines.push(`${name}${labels} ${s.value}`);
  }
  return lines.join("\n") + "\n";
}

export function buildMetrics(report: HealthReport): string {
  const nowSec = Date.now() / 1000;
  const out: string[] = [];

  out.push(metric("listener_up", "gauge", "1 if the listener health check passes", [{ value: report.ok ? 1 : 0 }]));
  out.push(metric("listener_ready", "gauge", "1 once the manager has completed a tick", [{ value: report.ready ? 1 : 0 }]));
  out.push(metric("listener_accounts_watched", "gauge", "Number of accounts currently being watched", [{ value: report.accounts.filter((a) => a.watching).length }]));
  out.push(metric("listener_accounts_missing_lease", "gauge", "Number of desired accounts without a held lease", [{ value: report.missingLeases.length }]));
  out.push(metric("listener_accounts_expired_lease", "gauge", "Number of watched accounts whose lease has expired", [{ value: report.expiredLeases.length }]));

  if (report.lastTickAt) {
    out.push(metric("listener_last_tick_seconds", "gauge", "Unix time of the last completed manager tick", [{ value: Math.floor(new Date(report.lastTickAt).getTime() / 1000) }]));
  }

  out.push(metric("listener_lease_expires_seconds", "gauge", "Unix time when the account lease expires",
    report.accounts.map((a) => ({ labels: { account: a.address }, value: Math.floor(new Date(a.leaseExpiresAt).getTime() / 1000) }))));
  out.push(metric("listener_last_poll_seconds", "gauge", "Unix time of the last successful poll for the account",
    report.accounts.map((a) => ({ labels: { account: a.address }, value: Math.floor(new Date(a.lastPollAt).getTime() / 1000) }))));

  out.push(metric("webhook_deliveries", "gauge", "Number of webhook deliveries by state", [
    { labels: { state: "queued" }, value: report.deliveries.queued },
    { labels: { state: "in_flight" }, value: report.deliveries.inFlight },
    { labels: { state: "dead" }, value: report.deliveries.dead },
  ]));

  // Staleness of the last tick as a seconds-since gauge for alerting.
  if (report.lastTickAt) {
    out.push(metric("listener_tick_age_seconds", "gauge", "Seconds since the last completed manager tick",
      [{ value: Math.floor(nowSec - new Date(report.lastTickAt).getTime() / 1000) }]));
  }

  return out.join("");
}

// ------------------------------------------------------------------------
// HTTP server
// ------------------------------------------------------------------------

export interface HealthServerOptions {
  port?: number;
  host?: string;
}

export function startHealthServer(db: SupabaseClient, opts: HealthServerOptions = {}): () => void {
  const port = opts.port ?? Number(process.env.PORT ?? "8080");
  const host = opts.host ?? "0.0.0.0";

  const server = createServer((async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed\n");
        return;
      }

      if (url.pathname === "/health" || url.pathname === "/healthz") {
        const report = await buildHealthReport(db);
        const body = JSON.stringify(report);
        res.writeHead(report.ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      if (url.pathname === "/metrics") {
        const report = await buildHealthReport(db);
        const body = buildMetrics(report);
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    } catch (e) {
      log("error", "health_request_failed", { error: String(e) });
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error\n");
      } catch { /* client gone */ }
    }
  }) as unknown as (req: any, res: any) => void);

  server.on("error", (e) => {
    log("error", "health_server_error", { error: String(e) });
  });

  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo | string | null;
    const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
    log("info", "health_server_listening", { address: where });
  });

  return () => {
    server.close(() => { /* noop */ });
  };
}

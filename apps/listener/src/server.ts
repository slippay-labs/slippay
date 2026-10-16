import http from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { HOLDER_ID } from "./lease.js";
import { log } from "./log.js";
import type { ManagerInspection } from "./manager.js";

export interface DeliveryCounts {
  queued: number;
  delivering: number;
  failed: number;
  dead: number;
  sent: number;
}

export interface HealthResponse {
  status: "ok" | "unhealthy";
  reason: string | null;
  uptime_s: number;
  network: string;
  holder_id: string;
  accounts: ManagerInspection["leases"];
  desired_accounts: string[];
  active_accounts: string[];
  lost_leases: string[];
  deliveries: DeliveryCounts;
}

export interface MetricsResponse {
  uptime_s: number;
  up: number;
  active_leases: number;
  desired_accounts: number;
  lost_leases: number;
  deliveries: DeliveryCounts;
}

export async function getDeliveryCounts(db: SupabaseClient): Promise<DeliveryCounts> {
  try {
    const [q, d, f, dd, s] = await Promise.all([
      db.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("status", "queued"),
      db.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("status", "delivering"),
      db.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("status", "failed"),
      db.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("status", "dead"),
      db.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("status", "sent"),
    ]);

    return {
      queued: q?.count ?? 0,
      delivering: d?.count ?? 0,
      failed: f?.count ?? 0,
      dead: dd?.count ?? 0,
      sent: s?.count ?? 0,
    };
  } catch (e) {
    log("error", "delivery_counts_fetch_error", { error: String(e) });
    return { queued: 0, delivering: 0, failed: 0, dead: 0, sent: 0 };
  }
}

export function evaluateHealth(
  inspection: ManagerInspection,
  deliveries: DeliveryCounts,
): {
  isHealthy: boolean;
  statusCode: number;
  response: HealthResponse;
} {
  let isHealthy = true;
  let reason: string | null = null;

  if (inspection.lostLeases.length > 0) {
    isHealthy = false;
    reason = "lost_lease";
  } else if (inspection.desiredAccounts.length > 0 && inspection.activeAccounts.length === 0) {
    isHealthy = false;
    reason = "no_leases_held";
  } else if (inspection.leases.some(l => !l.leased)) {
    isHealthy = false;
    reason = "unleased_desired_account";
  }

  const response: HealthResponse = {
    status: isHealthy ? "ok" : "unhealthy",
    reason,
    uptime_s: Math.round(process.uptime()),
    network: config.network,
    holder_id: HOLDER_ID,
    accounts: inspection.leases,
    desired_accounts: inspection.desiredAccounts,
    active_accounts: inspection.activeAccounts,
    lost_leases: inspection.lostLeases,
    deliveries,
  };

  return {
    isHealthy,
    statusCode: isHealthy ? 200 : 503,
    response,
  };
}

export function formatPrometheusMetrics(
  inspection: ManagerInspection,
  deliveries: DeliveryCounts,
  isHealthy: boolean,
): string {
  const up = isHealthy ? 1 : 0;
  const uptime = Math.round(process.uptime());
  const activeCount = inspection.activeAccounts.length;
  const desiredCount = inspection.desiredAccounts.length;
  const lostCount = inspection.lostLeases.length;

  return [
    "# HELP slippay_listener_up Process liveness and lease health (1 = healthy, 0 = unhealthy)",
    "# TYPE slippay_listener_up gauge",
    `slippay_listener_up ${up}`,
    "",
    "# HELP slippay_listener_uptime_seconds Process uptime in seconds",
    "# TYPE slippay_listener_uptime_seconds gauge",
    `slippay_listener_uptime_seconds ${uptime}`,
    "",
    "# HELP slippay_listener_active_leases Number of active account leases held",
    "# TYPE slippay_listener_active_leases gauge",
    `slippay_listener_active_leases ${activeCount}`,
    "",
    "# HELP slippay_listener_desired_accounts Number of accounts desired to be watched",
    "# TYPE slippay_listener_desired_accounts gauge",
    `slippay_listener_desired_accounts ${desiredCount}`,
    "",
    "# HELP slippay_listener_lost_leases Number of lost account leases",
    "# TYPE slippay_listener_lost_leases gauge",
    `slippay_listener_lost_leases ${lostCount}`,
    "",
    "# HELP slippay_listener_deliveries Webhook delivery count by status",
    "# TYPE slippay_listener_deliveries gauge",
    `slippay_listener_deliveries{status="queued"} ${deliveries.queued}`,
    `slippay_listener_deliveries{status="delivering"} ${deliveries.delivering}`,
    `slippay_listener_deliveries{status="failed"} ${deliveries.failed}`,
    `slippay_listener_deliveries{status="dead"} ${deliveries.dead}`,
    `slippay_listener_deliveries{status="sent"} ${deliveries.sent}`,
    "",
  ].join("\n");
}

export interface HealthServerDeps {
  db: SupabaseClient;
  getInspection: () => ManagerInspection;
  port?: number;
  host?: string;
}

export function createHealthServer(deps: HealthServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    if (pathname === "/health" || pathname === "/healthz") {
      const inspection = deps.getInspection();
      const deliveries = await getDeliveryCounts(deps.db);
      const { statusCode, response } = evaluateHealth(inspection, deliveries);

      const body = JSON.stringify(response);
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    if (
      pathname === "/v1/metrics" ||
      (pathname === "/metrics" && (req.headers.accept?.includes("application/json") || url.searchParams.get("format") === "json"))
    ) {
      const inspection = deps.getInspection();
      const deliveries = await getDeliveryCounts(deps.db);
      const { isHealthy } = evaluateHealth(inspection, deliveries);

      const metricsResponse: MetricsResponse = {
        uptime_s: Math.round(process.uptime()),
        up: isHealthy ? 1 : 0,
        active_leases: inspection.activeAccounts.length,
        desired_accounts: inspection.desiredAccounts.length,
        lost_leases: inspection.lostLeases.length,
        deliveries,
      };

      const body = JSON.stringify(metricsResponse);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    if (pathname === "/metrics") {
      const inspection = deps.getInspection();
      const deliveries = await getDeliveryCounts(deps.db);
      const { isHealthy } = evaluateHealth(inspection, deliveries);

      const prom = formatPrometheusMetrics(inspection, deliveries, isHealthy);
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(prom),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(prom);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

export async function startHealthServer(deps: HealthServerDeps): Promise<() => Promise<void>> {
  const port = deps.port ?? config.port;
  const host = deps.host ?? "0.0.0.0";
  const server = createHealthServer(deps);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      log("info", "health_server_listening", { port, host });
      resolve();
    });
    server.once("error", reject);
  });

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}

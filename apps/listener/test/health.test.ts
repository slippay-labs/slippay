import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../src/config.js", () => ({
  config: {
    network: "TESTNET",
    merchantNetwork: "testnet",
    port: 8080,
  },
}));

import {
  evaluateHealth,
  formatPrometheusMetrics,
  getDeliveryCounts,
  createHealthServer,
  startHealthServer,
  type DeliveryCounts,
} from "../src/server.js";
import type { ManagerInspection } from "../src/manager.js";

function makeMockDb(counts: Record<string, number> = {}, error: any = null) {
  const db: any = {
    from: (_table: string) => {
      let currentStatus: string | null = null;
      const builder: any = {
        select: (_fields: string, _opts: any) => builder,
        eq: (_col: string, val: string) => {
          currentStatus = val;
          return builder;
        },
        then: (resolve: (v: any) => void) => {
          if (error) {
            resolve({ data: null, error, count: null });
          } else {
            const count = currentStatus ? (counts[currentStatus] ?? 0) : 0;
            resolve({ data: [], error: null, count });
          }
        },
      };
      return builder;
    },
  };
  return db;
}

async function request(
  server: http.Server,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("evaluateHealth", () => {
  const emptyDeliveries: DeliveryCounts = { queued: 0, delivering: 0, failed: 0, dead: 0, sent: 0 };

  it("reports healthy when all desired accounts are leased", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["addr-1"],
      activeAccounts: ["addr-1"],
      leases: [{ account_id: "addr-1", leased: true, lease_expires_at: "2026-10-16T16:00:00Z", last_poll_at: "2026-10-16T15:00:00Z", cursor: "100" }],
      lostLeases: [],
    };
    const { isHealthy, statusCode, response } = evaluateHealth(inspection, emptyDeliveries);
    expect(isHealthy).toBe(true);
    expect(statusCode).toBe(200);
    expect(response.status).toBe("ok");
    expect(response.reason).toBeNull();
    expect(response.accounts).toHaveLength(1);
    expect(response.accounts[0].cursor).toBe("100");
  });

  it("reports unhealthy when a lease was lost", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["addr-1"],
      activeAccounts: [],
      leases: [{ account_id: "addr-1", leased: false }],
      lostLeases: ["addr-1"],
    };
    const { isHealthy, statusCode, response } = evaluateHealth(inspection, emptyDeliveries);
    expect(isHealthy).toBe(false);
    expect(statusCode).toBe(503);
    expect(response.status).toBe("unhealthy");
    expect(response.reason).toBe("lost_lease");
    expect(response.lost_leases).toContain("addr-1");
  });

  it("reports unhealthy when desired accounts exist but no leases are held", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["addr-1", "addr-2"],
      activeAccounts: [],
      leases: [{ account_id: "addr-1", leased: false }, { account_id: "addr-2", leased: false }],
      lostLeases: [],
    };
    const { isHealthy, statusCode, response } = evaluateHealth(inspection, emptyDeliveries);
    expect(isHealthy).toBe(false);
    expect(statusCode).toBe(503);
    expect(response.status).toBe("unhealthy");
    expect(response.reason).toBe("no_leases_held");
  });

  it("reports unhealthy when at least one desired account is unleased", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["addr-1", "addr-2"],
      activeAccounts: ["addr-1"],
      leases: [
        { account_id: "addr-1", leased: true },
        { account_id: "addr-2", leased: false },
      ],
      lostLeases: [],
    };
    const { isHealthy, statusCode, response } = evaluateHealth(inspection, emptyDeliveries);
    expect(isHealthy).toBe(false);
    expect(statusCode).toBe(503);
    expect(response.status).toBe("unhealthy");
    expect(response.reason).toBe("unleased_desired_account");
  });

  it("reports healthy when desired accounts is empty (idle listener)", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: [],
      activeAccounts: [],
      leases: [],
      lostLeases: [],
    };
    const { isHealthy, statusCode, response } = evaluateHealth(inspection, emptyDeliveries);
    expect(isHealthy).toBe(true);
    expect(statusCode).toBe(200);
    expect(response.status).toBe("ok");
  });
});

describe("getDeliveryCounts", () => {
  it("fetches exact counts for all delivery statuses", async () => {
    const db = makeMockDb({ queued: 3, delivering: 1, failed: 2, dead: 0, sent: 15 });
    const counts = await getDeliveryCounts(db);
    expect(counts).toEqual({
      queued: 3,
      delivering: 1,
      failed: 2,
      dead: 0,
      sent: 15,
    });
  });

  it("handles db query failure safely without throwing", async () => {
    const db = makeMockDb({}, new Error("network partition"));
    const counts = await getDeliveryCounts(db);
    expect(counts).toEqual({
      queued: 0,
      delivering: 0,
      failed: 0,
      dead: 0,
      sent: 0,
    });
  });
});

describe("formatPrometheusMetrics", () => {
  it("formats metrics accurately according to Prometheus spec", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["A", "B"],
      activeAccounts: ["A", "B"],
      leases: [{ accountId: "A", leased: true }, { accountId: "B", leased: true }],
      lostLeases: [],
    };
    const deliveries: DeliveryCounts = { queued: 4, delivering: 2, failed: 1, dead: 0, sent: 50 };
    const text = formatPrometheusMetrics(inspection, deliveries, true);

    expect(text).toContain("slippay_listener_up 1");
    expect(text).toContain("slippay_listener_active_leases 2");
    expect(text).toContain("slippay_listener_desired_accounts 2");
    expect(text).toContain("slippay_listener_lost_leases 0");
    expect(text).toContain('slippay_listener_deliveries{status="queued"} 4');
    expect(text).toContain('slippay_listener_deliveries{status="delivering"} 2');
    expect(text).toContain('slippay_listener_deliveries{status="failed"} 1');
    expect(text).toContain('slippay_listener_deliveries{status="dead"} 0');
    expect(text).toContain('slippay_listener_deliveries{status="sent"} 50');
  });

  it("sets slippay_listener_up to 0 when unhealthy", () => {
    const inspection: ManagerInspection = {
      desiredAccounts: ["A"],
      activeAccounts: [],
      leases: [{ accountId: "A", leased: false }],
      lostLeases: ["A"],
    };
    const text = formatPrometheusMetrics(inspection, { queued: 0, delivering: 0, failed: 0, dead: 0, sent: 0 }, false);
    expect(text).toContain("slippay_listener_up 0");
    expect(text).toContain("slippay_listener_lost_leases 1");
  });
});

describe("createHealthServer & HTTP routes", () => {
  let server: http.Server;
  let inspectionMock: ManagerInspection;

  beforeEach(async () => {
    inspectionMock = {
      desiredAccounts: ["GA..."],
      activeAccounts: ["GA..."],
      leases: [
        {
          account_id: "GA...",
          leased: true,
          lease_expires_at: "2026-10-16T16:00:00Z",
          last_poll_at: "2026-10-16T15:30:00Z",
          cursor: "token-999",
        },
      ],
      lostLeases: [],
    };
    const db = makeMockDb({ queued: 2, delivering: 1, failed: 0, dead: 0, sent: 10 });
    server = createHealthServer({
      db,
      getInspection: () => inspectionMock,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves GET /health with 200 and complete state when healthy", async () => {
    const res = await request(server, "/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const json = JSON.parse(res.body);
    expect(json.status).toBe("ok");
    expect(json.reason).toBeNull();
    expect(json.desired_accounts).toEqual(["GA..."]);
    expect(json.active_accounts).toEqual(["GA..."]);
    expect(json.accounts[0].cursor).toBe("token-999");
    expect(json.accounts[0].last_poll_at).toBe("2026-10-16T15:30:00Z");
    expect(json.deliveries).toEqual({
      queued: 2,
      delivering: 1,
      failed: 0,
      dead: 0,
      sent: 10,
    });
  });

  it("serves HEAD /health with 200 and empty body", async () => {
    const res = await request(server, "/health", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });

  it("serves GET /health with 503 when listener has lost a lease", async () => {
    inspectionMock.lostLeases = ["GA..."];
    inspectionMock.activeAccounts = [];
    inspectionMock.leases[0].leased = false;

    const res = await request(server, "/health");
    expect(res.status).toBe(503);
    const json = JSON.parse(res.body);
    expect(json.status).toBe("unhealthy");
    expect(json.reason).toBe("lost_lease");
    expect(json.lost_leases).toEqual(["GA..."]);
  });

  it("serves GET /v1/metrics with JSON metrics matching API pattern", async () => {
    const res = await request(server, "/v1/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const json = JSON.parse(res.body);
    expect(json.up).toBe(1);
    expect(json.active_leases).toBe(1);
    expect(json.desired_accounts).toBe(1);
    expect(json.lost_leases).toBe(0);
    expect(json.deliveries.queued).toBe(2);
  });

  it("serves GET /metrics as Prometheus text by default", async () => {
    const res = await request(server, "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("slippay_listener_up 1");
    expect(res.body).toContain('slippay_listener_deliveries{status="queued"} 2');
  });

  it("serves GET /metrics with Accept: application/json as JSON", async () => {
    const res = await request(server, "/metrics", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = JSON.parse(res.body);
    expect(json.up).toBe(1);
  });

  it("returns 404 for unknown endpoints", async () => {
    const res = await request(server, "/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 405 for unsupported HTTP methods", async () => {
    const res = await request(server, "/health", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("startHealthServer lifecycle", () => {
  it("starts and shuts down cleanly on configured port", async () => {
    const db = makeMockDb({});
    const stop = await startHealthServer({
      db,
      getInspection: () => ({ desiredAccounts: [], activeAccounts: [], leases: [], lostLeases: [] }),
      port: 0, // Pick random free port
      host: "127.0.0.1",
    });

    expect(typeof stop).toBe("function");
    await expect(stop()).resolves.toBeUndefined();
  });
});

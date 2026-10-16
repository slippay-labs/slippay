import { config } from "./config.js";

export interface ListenerHealthStatus {
  status: "ok" | "degraded";
  network: string;
  isMainnet: boolean;
  allowLocalWebhooks: boolean;
  warnings?: string[];
}

/**
 * Returns current listener health and security operational status.
 * When ALLOW_LOCAL_WEBHOOKS escape hatch is enabled, health status reports
 * "degraded" with an explicit warning so operators and monitors can detect it.
 */
export function getHealthStatus(): ListenerHealthStatus {
  const warnings: string[] = [];
  if (config.allowLocalWebhooks) {
    warnings.push("ALLOW_LOCAL_WEBHOOKS is enabled; SSRF protections are relaxed for local mock targets");
  }
  return {
    status: config.allowLocalWebhooks ? "degraded" : "ok",
    network: config.network,
    isMainnet: config.isMainnet,
    allowLocalWebhooks: config.allowLocalWebhooks,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

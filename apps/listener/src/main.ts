import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";
import { getHealthStatus } from "./health.js";

async function main() {
  log("info", "listener_starting", {
    network: config.network,
    allowLocalWebhooks: config.allowLocalWebhooks,
  });

  if (config.allowLocalWebhooks) {
    log("warn", "local_webhooks_escape_hatch_active", {
      warning: "ALLOW_LOCAL_WEBHOOKS is enabled: SSRF defences are relaxed for dev/mock targets. Must never be enabled in production.",
      health: getHealthStatus(),
    });
  }

  const stop = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  process.on("SIGTERM", () => { log("info", "listener_stop"); stopWebhook(); stop(); process.exit(0); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });

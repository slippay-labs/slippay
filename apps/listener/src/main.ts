import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { startHealthServer } from "./health.js";
import { log } from "./log.js";

async function main() {
  log("info", "listener_starting", { network: config.network });
  const manager = startManager(db);
  const stopHealth = startHealthServer(db, () => manager.isHealthy());
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  process.on("SIGTERM", () => { log("info", "listener_stop"); stopHealth(); stopWebhook(); manager.stop().then(() => process.exit(0)); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });

import { config, validateConfig } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";

async function main() {
  // Fail close on out-of-range configuration at startup.
  validateConfig(config);
  log("info", "listener_starting", { network: config.network });
  const stop = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  process.on("SIGTERM", () => { log("info", "listener_stop"); stopWebhook(); stop(); process.exit(0); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });

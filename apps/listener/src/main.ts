import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startHorizon } from "./horizon.js";
import { startCursorReset } from "./horizon.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";

async function main() {
  log("info", "listener_starting", { network: config.network });
  const stop = startManager(db);
  const stopHorizon = startHorizon(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  process.on("SIGTERM", () => { log("info", "listener_stop"); stopWebhook(); stopHorizon(); stop(); process.exit(0); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });

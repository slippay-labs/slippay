import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { startHealthServer } from "./server.js";
import { log } from "./log.js";

async function main() {
  log("info", "listener_starting", { network: config.network, port: config.port });
  const manager = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  const stopHealthServer = await startHealthServer({
    db,
    port: config.port,
    getInspection: manager.getInspection,
  });

  const shutdown = async () => {
    log("info", "listener_stop");
    await stopHealthServer();
    stopWebhook();
    await manager();
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });


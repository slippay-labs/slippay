import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";
import { createShutdownHandler } from "./shutdown.js";

export { createShutdownHandler };

async function main() {
  log("info", "listener_starting", { network: config.network });
  const stop = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);

  const onSignal = createShutdownHandler(stop, stopWebhook);
  process.on("SIGTERM", () => { void onSignal("SIGTERM"); });
  process.on("SIGINT", () => { void onSignal("SIGINT"); });

  await new Promise(() => {});
}

if (process.env.NODE_ENV !== "test") {
  main().catch((e) => {
    log("error", "fatal", { error: String(e) });
    process.exit(1);
  });
}

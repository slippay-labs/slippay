import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";

function isProduction(): boolean {
  const env = (process.env.NODE_ENV ?? "").toLowerCase();
  return env === "production" || env === "prod";
}

async function main() {
  if (config.allowLocalWebhooks) {
    if (isProduction()) {
      throw new Error(
        "allowLocalWebhooks is enabled in a production environment; refusing to start. " +
          "Disable the dev-only webhook escape hatch before deploying.",
      );
    }
    log("warn", "webhook_local_escape_hatch_active", {
      message:
        "allowLocalWebhooks is enabled: SSF protections for outbound webhooks are relaxed. " +
        "This must only be used in development/test environments.",
    });
  }

  log("info", "listener_starting", { network: config.network });
  const stop = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);
  process.on("SIGTERM", () => { log("info", "listener_stop"); stopWebhook(); stop(); process.exit(0); });
  await new Promise(() => {});
}

main().catch(e => { log("error", "fatal", { error: String(e) }); process.exit(1); });

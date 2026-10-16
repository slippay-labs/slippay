import { config } from "./config.js";
import { db } from "./db.js";
import { startManager } from "./manager.js";
import { startWebhookWorker } from "./webhook.js";
import { log } from "./log.js";

export interface ShutdownDeps {
  stop: () => Promise<void>;
  stopWebhook: () => Promise<void>;
  exit: (number?: number) => void;
  on: (signal: string, fn: () => Promise<void>) => unknown;
  timeoutMs?: number;
}

export function registerShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 5000;
  let shutting = false;

  const shutdown = async (signal: string, reason: string) => {
    if (shutting) {
      log("warn", "listener_stop_duplicate", { signal, reason });
      return;
    }
    shutting = true;
    log("info", "listener_stop", { signal, reason });

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        log("error", "listener_stop_timeout", { timeoutMs });
        resolve();
      }, timeoutMs)
    );

    await Promise.race([
      (async () => {
        try {
          await deps.stopWebhook();
        } catch (e) {
          log("error", "listener_stop_webhook_error", { error: String(e) });
        }
        try {
          await deps.stop();
        } catch (e) {
          log("info", "listener_stop_manager_error", { error: String(e) });
        }
      })(),
      timeout,
    ]);

    log("info", "listener_stop_complete", { signal, reason });
    deps.exit(0);
  };

  deps.on("SIGTERM", () => shutdown("SIGTERM", "signal"));
  deps.on("SIGINT", () => shutdown("SIGINT", "signal"));

  return () => shutdown("manual", "manual");
}

async function main() {
  log("info", "listener_starting", { network: config.network });
  const stop = startManager(db);
  const stopWebhook = startWebhookWorker(db, config.allowLocalWebhooks);

  registerShutdownHandler({
    stop,
    stopWebhook,
    exit: (number?: number) => process.exit(number),
    on: (signal, fn) => process.on(signal as NodeJS.Signals, fn),
  });

  await new Promise(() => {});
}

if (process.env.VITEST_SHUTDOWN_HANDLER_ONLY !== "1") {
  main().catch((e) => { log("log", "fatal", { error: String(e) }); process.exit(1); });
}

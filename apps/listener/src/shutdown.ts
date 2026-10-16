import { log } from "./log.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Creates an async graceful shutdown handler for process termination signals (fixes #254).
 * Properly awaits lease releases and worker stops before calling process.exit.
 */
export function createShutdownHandler(
  stop: () => Promise<void>,
  stopWebhook: () => void | Promise<void>,
  exitFn: (code?: number) => void = process.exit,
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
) {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "listener_stop", { signal });

    const timeout = new Promise<void>((_, reject) => {
      const t = setTimeout(() => reject(new Error("shutdown_timeout")), timeoutMs);
      if (typeof t.unref === "function") t.unref();
    });

    try {
      await Promise.race([
        (async () => {
          await Promise.resolve(stopWebhook());
          await stop();
        })(),
        timeout,
      ]);
      log("info", "listener_stopped_cleanly", { signal });
    } catch (err) {
      log("warn", "listener_shutdown_timed_out_or_failed", { signal, error: String(err) });
    } finally {
      exitFn(0);
    }
  };
}

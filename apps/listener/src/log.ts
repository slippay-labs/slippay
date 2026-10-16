type Level = "info" | "warn" | "error" | "debug" | "alert";
export function log(level: Level, msg: string, ctx: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }));
}

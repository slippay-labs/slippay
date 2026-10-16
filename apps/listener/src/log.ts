type Level = "info" | "warn" | "error" | "debug" | "alert";
export function log(level: Level, msg: string, ctx: Record<string, unknown> = {}) {
  const out = level === "alert" ? console.error : console.log;
  out(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }));
}

/**
 * Strips or redacts sensitive bearer tokens (such as checkout ?t= query parameter)
 * from URLs to prevent credential leakage in access logs, referrers, and error reports.
 */
export function redactUrlToken(urlOrPath: string): string {
  if (!urlOrPath) return urlOrPath;
  if (!urlOrPath.includes("t=")) return urlOrPath;
  // Match ?t=... or &t=... preserving delimiters and stopping before next & or # or end
  return urlOrPath.replace(/([?&]t=)[^&#\s]*/g, "$1[REDACTED]");
}

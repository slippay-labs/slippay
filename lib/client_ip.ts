import type { Request } from "express";

/**
 * Extract a trusted client IP from the request.
 *
 * We only trust forwarding headers when the request has been marked as coming
 * through a trusted proxy (req.trustedProxy = true). Otherwise we fall back to
 * the socket address. If nothing is available we return a shared "anon" bucket.
 */
export function getClientIp(req: Request): string {
  const trusted = Boolean(req.trustedProxy);

  if (trusted) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      // Take the leftmost address (the original client) and strip: port.
      const first = xff.split(",")[0].trim();
      // Handle IPv6 bracket notation and IP:port.
      const normalized = first
        .replace(/^\[(.*?)](:\d+)?$/, "$1")
        .replace(/:(\d+)$/, "");
      if (normalized.length > 0) {
        return normalized;
      }
    }

    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real.length > 0) {
      return real.trim();
    }
  }

  const socket = req.socket?.remoteAddress;
  if (socket && socket.length > 0) {
    return socket;
  }

  return "anon";
}
